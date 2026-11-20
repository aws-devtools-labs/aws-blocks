// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenNext `cdnInvalidation` override that propagates Next.js on-demand
 * revalidation (`revalidateTag`, `revalidatePath`, `res.revalidate`) to the
 * CloudFront front door.
 *
 * OpenNext answers ISR pages with `s-maxage=<remaining revalidate>` and the
 * SSR cache policy honours it, so without an invalidation the edge keeps
 * serving the old page for the rest of that window even though the origin
 * has regenerated it.
 *
 * The generated `open-next.config.ts` imports this module (by absolute path)
 * as the default function's `cdnInvalidation` override. It runs inside the
 * server Lambda and needs two things from the Hosting construct, both
 * injected only for the CloudFront door:
 *
 * - `HOSTING_CDN_INVALIDATION_PARAM` — the name of an SSM parameter holding
 *   the distribution id. The id can't be put in the function's environment
 *   directly: the distribution's origin depends on the function, so the
 *   reverse reference would be a dependency cycle.
 * - `cloudfront:CreateInvalidation` on that one distribution, plus
 *   `ssm:GetParameter` on that one parameter.
 *
 * Without `HOSTING_CDN_INVALIDATION_PARAM` (another front door, local runs)
 * every call is a no-op.
 *
 * Runtime code: no CDK imports.
 *
 * @module
 */

import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import {
	CDN_INVALIDATION_BASE_PATH_ENV,
	CDN_INVALIDATION_HANDLER_NAME,
	CDN_INVALIDATION_PARAM_ENV,
} from './shared/cdn_invalidation_env.js';

export { CDN_INVALIDATION_BASE_PATH_ENV, CDN_INVALIDATION_HANDLER_NAME, CDN_INVALIDATION_PARAM_ENV };

/**
 * Above this many paths in one revalidation, a single `/*` invalidation is
 * issued instead (one path, no per-path charge, and well inside CloudFront's
 * in-progress invalidation limits).
 */
export const MAX_INVALIDATION_PATHS = 50;

/** OpenNext's soft (implicit, path-derived) tag prefix. */
const SOFT_TAG_PREFIX = '_N_T_/';

/** Route-scoped cache keys (Next 15.5.27+ / 16.3.8+): `route-cache/<KIND>/<sha256>/$/<path>`. */
const ROUTE_CACHE_KEY = /^\/?route-cache\/(PAGES|APP_PAGE|APP_ROUTE)\/[0-9a-f]{64}\/\$(\/.*)$/;

/** A fetch / `unstable_cache` entry key: never a CDN path. */
const DATA_CACHE_KEY = /^[0-9a-f]{64}$/;

/** A path OpenNext hands to `invalidatePaths` (a subset of its `CDNPath`). */
export interface CdnPath {
	initialPath: string;
	rawPath?: string;
	resolvedRoutes: ReadonlyArray<{ route?: string; type: string }>;
}

/** The parts of OpenNext's tag cache this handler reads (both tag cache modes). */
export interface TagCacheLike {
	getByTag?: (tag: string) => Promise<string[]>;
	getPathsByTags?: (tags: string[]) => Promise<string[]>;
}

/** The shape OpenNext expects from a `cdnInvalidation` override. */
export interface CdnInvalidationHandler {
	name: string;
	invalidatePaths: (paths: CdnPath[]) => Promise<void>;
	invalidateTags: (tags: string[]) => Promise<void>;
}

/** Collaborators, injectable for tests. */
export interface CdnInvalidationDeps {
	/** Issue one invalidation of `paths` on `distributionId`. */
	createInvalidation?: (distributionId: string, paths: string[]) => Promise<void>;
	/** Read the distribution id from the named SSM parameter. */
	readDistributionId?: (parameterName: string) => Promise<string>;
	/** The tag cache. @default globalThis.tagCache (set by OpenNext) */
	tagCache?: () => TagCacheLike | undefined;
	/** Environment. @default process.env */
	env?: NodeJS.ProcessEnv;
}

/** A page path the CDN caches, and whether it is a Pages Router page. */
interface PagePath {
	path: string;
	pagesRouter: boolean;
}

/** Mirrors Next's `denormalizePagePath`: `/index` → `/`, `/index/index/x` → `/index/x`. */
function denormalizePagePath(page: string): string {
	if (page.startsWith('/index/') && !/\/\[[^/]+?\](?=\/|$)/.test(page)) return page.slice(6);
	return page === '/index' ? '/' : page;
}

/**
 * The page path a tag-cache key stands for, or `undefined` for a data-cache
 * (fetch / `unstable_cache`) key, which the CDN never caches.
 *
 * @param key a key from the tag cache, without the build id
 * @returns the page path, or `undefined`
 */
export function cacheKeyToPagePath(key: string): PagePath | undefined {
	const route = ROUTE_CACHE_KEY.exec(key);
	if (route) return { path: denormalizePagePath(route[2]), pagesRouter: route[1] === 'PAGES' };
	if (DATA_CACHE_KEY.test(key) || key === '') return undefined;
	// Older Next releases key a page by its path (`blog/hello`, `index`).
	return { path: denormalizePagePath(key.startsWith('/') ? key : `/${key}`), pagesRouter: false };
}

/**
 * The page path a soft tag names directly (`_N_T_/blog/hello` → `/blog/hello`),
 * so `revalidatePath()` reaches a page the tag cache has no row for. Tags for a
 * layout, a `page` / `route` segment or a dynamic pattern name no single URL and
 * return `undefined`; their pages are found through the tag cache.
 */
function softTagPath(tag: string): string | undefined {
	if (!tag.startsWith(SOFT_TAG_PREFIX)) return undefined;
	const path = `/${tag.slice(SOFT_TAG_PREFIX.length)}`.replace(/\/+$/, '') || '/';
	if (/\/(layout|page|route)$/.test(path) || path === '/layout' || path.includes('[')) return undefined;
	return path;
}

/** Percent-encode what CloudFront needs encoded in an invalidation path, leaving `/` and `*`. */
function encodePath(path: string): string {
	return path
		.split('/')
		.map((segment) => (segment === '*' ? segment : encodeURIComponent(decodeSafely(segment))))
		.join('/');
}

function decodeSafely(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/**
 * Turn page paths into CloudFront invalidation paths: the `basePath` prefix,
 * the Pages Router data route next to a Pages Router page, deduplicated, and
 * collapsed to a single `/*` past {@link MAX_INVALIDATION_PATHS}.
 *
 * One exact path covers both the HTML and the RSC payload: the SSR cache
 * policy keys RSC requests on the `rsc` header and leaves `_rsc` out of the
 * cache key, and an invalidation drops every cached variant of a path.
 *
 * @param pages the pages to invalidate
 * @param options.basePath the app's Next.js `basePath`, if any
 * @param options.buildId the build id (`OPEN_NEXT_BUILD_ID`), for Pages Router data routes
 * @returns the invalidation paths (empty when there is nothing to invalidate)
 */
export function toInvalidationPaths(
	pages: ReadonlyArray<PagePath>,
	options: { basePath?: string; buildId?: string } = {},
): string[] {
	const base = (options.basePath ?? '').replace(/\/+$/, '');
	const out = new Set<string>();
	for (const { path, pagesRouter } of pages) {
		const clean = path.startsWith('/') ? path : `/${path}`;
		out.add(clean === '/' && base ? base : `${base}${clean}`);
		if (pagesRouter && options.buildId) {
			out.add(`${base}/_next/data/${options.buildId}${clean === '/' ? '/index' : clean}.json`);
		}
	}
	if (out.size === 0) return [];
	if (out.size > MAX_INVALIDATION_PATHS) return [`${base}/*`];
	return [...out].map(encodePath);
}

function defaultCreateInvalidation(): (distributionId: string, paths: string[]) => Promise<void> {
	let client: CloudFrontClient | undefined;
	return async (distributionId, paths) => {
		client ??= new CloudFrontClient({});
		await client.send(
			new CreateInvalidationCommand({
				DistributionId: distributionId,
				InvalidationBatch: {
					Paths: { Quantity: paths.length, Items: paths },
					CallerReference: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
				},
			}),
		);
	};
}

function defaultReadDistributionId(): (parameterName: string) => Promise<string> {
	let client: SSMClient | undefined;
	return async (parameterName) => {
		client ??= new SSMClient({});
		const out = await client.send(new GetParameterCommand({ Name: parameterName }));
		const value = out.Parameter?.Value;
		if (!value) throw new Error(`SSM parameter ${parameterName} has no value.`);
		return value;
	};
}

/**
 * Create the `cdnInvalidation` handler.
 *
 * @param deps collaborators to replace (tests); the defaults call AWS.
 * @returns the handler OpenNext calls after a revalidation.
 */
export function createCdnInvalidationHandler(deps: CdnInvalidationDeps = {}): CdnInvalidationHandler {
	const env = deps.env ?? process.env;
	const createInvalidation = deps.createInvalidation ?? defaultCreateInvalidation();
	const readDistributionId = deps.readDistributionId ?? defaultReadDistributionId();
	const tagCache = deps.tagCache ?? (() => (globalThis as { tagCache?: TagCacheLike }).tagCache);
	let distributionId: Promise<string> | undefined;

	const invalidate = async (pages: PagePath[]): Promise<void> => {
		const parameterName = env[CDN_INVALIDATION_PARAM_ENV];
		if (!parameterName) return;
		const paths = toInvalidationPaths(pages, {
			basePath: env[CDN_INVALIDATION_BASE_PATH_ENV],
			buildId: env.OPEN_NEXT_BUILD_ID,
		});
		if (paths.length === 0) return;
		distributionId ??= readDistributionId(parameterName).catch((e: unknown) => {
			// Retry the lookup on the next revalidation instead of caching the failure.
			distributionId = undefined;
			throw e;
		});
		await createInvalidation(await distributionId, paths);
	};

	return {
		name: CDN_INVALIDATION_HANDLER_NAME,
		async invalidatePaths(paths) {
			await invalidate(
				paths.map(({ initialPath, resolvedRoutes }) => ({
					path: initialPath.startsWith('/') ? initialPath : `/${initialPath}`,
					pagesRouter: resolvedRoutes.length > 0 && !resolvedRoutes.some((r) => r.type === 'app'),
				})),
			);
		},
		// OpenNext calls this (instead of `invalidatePaths`) after `revalidateTag`
		// and `revalidatePath`. Its own tag→path mapping only follows soft tags, so a
		// page tagged through `fetch` / `unstable_cache` would never be purged;
		// resolve every tag to the pages that carry it here instead.
		async invalidateTags(tags) {
			if (!env[CDN_INVALIDATION_PARAM_ENV] || tags.length === 0) return;
			const cache = tagCache();
			let keys: string[] = [];
			if (cache?.getPathsByTags) {
				keys = await cache.getPathsByTags(tags);
			} else if (cache?.getByTag) {
				const getByTag = cache.getByTag.bind(cache);
				keys = (await Promise.all(tags.map((tag) => getByTag(tag)))).flat();
			}
			const pages: PagePath[] = [];
			for (const key of keys) {
				const page = cacheKeyToPagePath(key);
				if (page) pages.push(page);
			}
			for (const tag of tags) {
				const path = softTagPath(tag);
				if (path) pages.push({ path, pagesRouter: false });
			}
			await invalidate(pages);
		},
	};
}

/** The handler the generated `open-next.config.ts` installs. */
const handler: CdnInvalidationHandler = createCdnInvalidationHandler();
export default handler;
