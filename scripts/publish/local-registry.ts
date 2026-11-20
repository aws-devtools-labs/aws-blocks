// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Directory (relative to the repo root) that `npm run publish:local` writes and `serve-local-registry.ts` serves. */
export const LOCAL_REGISTRY_DIRNAME = "dist-registry";

/** Public registry that `serve-local-registry.ts` forwards third-party packages to. */
export const UPSTREAM_REGISTRY = "https://registry.npmjs.org";

/** URL path under which `serve-local-registry.ts` serves packages. */
const REGISTRY_PATH_PREFIX = "/registry/";

const SCOPE = "@aws-cdk-blocks/";
const UMBRELLA_PKG = "aws-cdk-blocks";

/** Absolute path of the local file-based registry for the repo at `root`. */
export function localRegistryDir(root: string): string {
	return join(resolve(root), LOCAL_REGISTRY_DIRNAME);
}

/**
 * Empty the local file-based registry so a local publish starts from scratch.
 *
 * The publish script refuses to overwrite a version that already exists with
 * different content. That guard protects the real (S3) registry, where a
 * version is immutable. The local registry is only a scratch copy of the
 * working tree, rebuilt on every run, so anything left from a previous run is
 * stale. Without this reset, re-publishing after a code change that did not
 * bump a version fails with "already exists with different content".
 *
 * Only deletes `<root>/dist-registry`. It throws for any other path, so a bad
 * argument can never remove anything else. If `dist-registry` is a symlink,
 * only the link is removed, not what it points to.
 */
export async function resetLocalRegistry(root: string, dir: string): Promise<void> {
	const expected = localRegistryDir(root);
	const target = resolve(dir);
	if (target !== expected) {
		throw new Error(`Refusing to reset local registry at ${target}: expected exactly ${expected}`);
	}
	await rm(target, { recursive: true, force: true });
	await mkdir(target, { recursive: true });
}

/**
 * Map a request URL from `serve-local-registry.ts` to a file inside `registryDir`.
 *
 * Returns the decoded URI (with `/index.json` appended for metadata requests)
 * and the absolute file path, or `undefined` when the path resolves outside
 * `registryDir` or the URL has malformed percent-encoding.
 */
export function resolveRegistryRequest(
	registryDir: string,
	rawUrl: string,
): { uri: string; filePath: string } | undefined {
	// Decode %2f for scoped packages (same as CloudFront Function)
	let uri: string;
	try {
		uri = decodeURIComponent(rawUrl);
	} catch (err) {
		if (err instanceof URIError) {
			return undefined;
		}
		throw err;
	}

	// Append /index.json for metadata requests (not tarballs)
	if (!uri.endsWith(".tgz")) {
		uri = uri + "/index.json";
	}

	const root = resolve(registryDir);
	const filePath = resolve(root, uri.replace(/^\/+/, ""));

	// The resolved path must stay within registryDir. A plain startsWith(root)
	// check is not enough: a sibling such as `dist-registry-extra` shares the
	// string prefix but is a different directory. path.relative gives a path
	// starting with `..` (or an absolute path on another Windows drive) for
	// anything outside root.
	const rel = relative(root, filePath);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		return undefined;
	}
	return { uri, filePath };
}

/**
 * Upstream URL for a request this registry does not hold, or `undefined` when
 * the request must 404 instead.
 *
 * Serving the repo's own packages locally while forwarding everything else lets
 * the harnesses point npm's default `registry=` here, which is the only way to
 * route the unscoped `aws-cdk-blocks` umbrella: npm resolves a registry per
 * scope, so a `@aws-cdk-blocks:registry=` line cannot match it.
 *
 * This repo's own packages never fall through. They exist on the public
 * registry too, so forwarding a miss would install a released copy in place of
 * the working tree's, which is the substitution `assertLocalRegistry` exists to
 * catch. A missing one is a real publish failure and stays a 404.
 */
export function upstreamRegistryUrl(rawUrl: string): string | undefined {
	if (!rawUrl.startsWith(REGISTRY_PATH_PREFIX)) {
		return undefined;
	}
	const raw = rawUrl.slice(REGISTRY_PATH_PREFIX.length);

	let name: string;
	try {
		name = decodeURIComponent(raw);
	} catch (err) {
		if (err instanceof URIError) {
			return undefined;
		}
		throw err;
	}

	if (name.startsWith(SCOPE) || name === UMBRELLA_PKG || name.startsWith(`${UMBRELLA_PKG}/`)) {
		return undefined;
	}

	// A package name never begins with a path separator and never contains `..`.
	// A leading separator makes the remainder an authority, moving the request to
	// another host: `//evil.example.com` and `\\evil.example.com` both do it, and
	// so do their percent-encoded forms, which is why the decoded name is checked
	// as well as the raw value. Neither is something npm sends.
	const SEPARATOR_PREFIX = /^[/\\]/;
	if (SEPARATOR_PREFIX.test(raw) || SEPARATOR_PREFIX.test(name) || name.includes("..")) {
		return undefined;
	}

	// Backstop: resolve against the upstream base and require the result to still
	// be on it, so a separator form not enumerated above cannot forward the
	// request off the public registry. Built with URL rather than string
	// concatenation so the host is verified rather than assumed.
	const base = `${UPSTREAM_REGISTRY}/`;
	let forwarded: URL;
	try {
		forwarded = new URL(raw, base);
	} catch {
		return undefined;
	}
	if (forwarded.origin !== new URL(base).origin) {
		return undefined;
	}

	// Forwarded exactly as npm spelled it, so a scoped name keeps its %2f.
	return `${UPSTREAM_REGISTRY}/${raw}`;
}
