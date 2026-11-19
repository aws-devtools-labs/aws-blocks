// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Regression guard: the sandbox state directory and the URL it is served at must
 * rename TOGETHER, everywhere.
 *
 * `.cdk-blocks-sandbox` is two things wearing one string. It is a path on disk
 * (`<projectRoot>/.cdk-blocks-sandbox/sandbox-id.txt`) and it is a public URL
 * path (`GET /.cdk-blocks-sandbox/config.json`, published by the Hosting
 * construct as a CloudFront static behaviour and answered by the dev server).
 * The two populations are indistinguishable as text, which is exactly how the
 * `aws-blocks/` → `cdk-blocks/` rename broke 24 tests: a sweep that renames the
 * disk paths and misses the published path leaves a browser asking for a URL
 * nothing serves, and the client cannot resolve its API URL at all.
 *
 * Neither name is centralized enough to make this a type error. `BLOCKS_SANDBOX_DIR`
 * (disk) and `BLOCKS_SANDBOX_PREFIX` (URL) are two separate constants with, between
 * them, a handful of callers; the overwhelming majority of references are hardcoded
 * literals in templates, test apps, gitignores, `cdk.json` watch-excludes and CI
 * workflows. Renaming the constants compiles clean while hundreds of literals still
 * say the old name, and nothing goes red.
 *
 * So this guard checks BOTH directions:
 *
 *  1. NEGATIVE — no live reference to the old name survives. Every git-tracked
 *     file is scanned for `.blocks-sandbox`. Historical records that must keep the
 *     old name (published changelogs, decision records, the legacy-app migration
 *     fixture) are named in {@link HISTORICAL_FILES} with a reason. Shipped source
 *     may name the old directory ONLY as the migration's legacy-source constant
 *     (see {@link LEGACY_CONSTANT}), because the copy-forward step has to know
 *     where to read from.
 *
 *  2. POSITIVE — every COUPLED site carries the new name. A sweep that renames the
 *     disk constant and forgets the CloudFront behaviour would pass a
 *     "no old references" check in isolation only if it also deleted the site; these
 *     assertions pin each coupled site by content, so a missing edit fails loudly
 *     and names the site. {@link COUPLED_SITES} is the list the PR had to move as
 *     one unit.
 *
 * It is a TEXT scan, not a runtime import: most of the surface is JSON, YAML,
 * gitignores and template files that no import can reach.
 *
 * Run: node --test dist/sandbox-dir-coverage.test.js
 */
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(pkgRoot, '..', '..');

/** The directory and served path this repo uses now. */
const CURRENT = '.cdk-blocks-sandbox';

/** The name it was renamed FROM. Spelled in pieces so this file is not itself a hit. */
const LEGACY = `.blocks${'-'}sandbox`;

/**
 * The one declaration allowed to name the legacy directory in shipped source: the
 * migration reads the old location to copy state forward (D-030). Any OTHER
 * occurrence in a shipped `src` tree is a missed rename.
 */
const LEGACY_CONSTANT = 'LEGACY_SANDBOX_DIR';

/**
 * Files that must KEEP the legacy name, each with a reason. Keep this list SHORT —
 * every entry is a record of the past, not a place to park a missed rename.
 */
const HISTORICAL_FILES: Record<string, string> = {
	'docs/DECISIONS.md': 'decision records are preserved as originally written; D-030 records the rename',
	'packages/blocks/test-fixtures/migrate-apps.json':
		'fixtures of pre-migration apps — the migrate test asserts against the OLD layout',
	'.changeset/cdk-blocks-sandbox-dir-rename.md':
		'the release note for the rename itself — it has to name the directory it renames FROM, and tell users which path stops being served',
	'native/kotlin/.changeset/cdk-blocks-sandbox-dir-rename.md':
		"the Kotlin release note for the same rename: it names the directory the codegen task's error message used to point at",
};

/** Published changelog entries describe shipped releases and cannot be rewritten. */
const isChangelog = (path: string): boolean => path.endsWith('CHANGELOG.md');

/**
 * Individual lines that must KEEP the legacy name, keyed by file and matched by a
 * substring that identifies them. Unlike {@link HISTORICAL_FILES} this leaves the
 * rest of the file guarded, so a NEW stale reference in one of them still fails.
 */
const LEGACY_NAME_REQUIRED_LINES: Record<string, readonly string[]> = {
	// The copy-forward leaves the old directory on disk, so it must stay ignored.
	'.gitignore': [`${LEGACY}/`],
	// Prose about an app's state BEFORE upgrading, which really was at the old path.
	'.changeset/core-deploy-config-per-stage.md': ['may still have a deployed URL in'],
	// The harness deploys a release from before the rename and reads the outputs file that the release wrote.
	'test-apps/comprehensive/test/upgrade-sql-blocks.ts': ["for (const dir of ['.cdk-blocks-sandbox',"],
};

/** Every git-tracked file, repo-relative. */
function trackedFiles(): string[] {
	const out = execFileSync('git', ['ls-files', '-z'], {
		cwd: repoRoot,
		encoding: 'utf-8',
		maxBuffer: 64 * 1024 * 1024,
	});
	return out.split('\0').filter((p) => p.length > 0);
}

/** `path` read as UTF-8, or null when it is not a readable text file. */
function readText(path: string): string | null {
	try {
		return readFileSync(join(repoRoot, path), 'utf-8');
	} catch {
		return null;
	}
}

test('no live reference to the legacy sandbox directory survives', () => {
	const offenders: string[] = [];

	for (const path of trackedFiles()) {
		if (path === 'packages/blocks/src/sandbox-dir-coverage.test.ts') continue;
		if (isChangelog(path) || path in HISTORICAL_FILES) continue;

		const text = readText(path);
		if (text === null || !text.includes(LEGACY)) continue;

		const isShippedSource = /^packages\/[^/]+\/src\//.test(path) && !path.includes('.test.');
		const allowedProse = LEGACY_NAME_REQUIRED_LINES[path] ?? [];

		for (const [i, line] of text.split('\n').entries()) {
			if (!line.includes(LEGACY)) continue;
			// The migration's legacy-source constant is the one permitted mention in source.
			if (isShippedSource && line.includes(LEGACY_CONSTANT)) continue;
			if (allowedProse.some((marker) => line.includes(marker))) continue;
			offenders.push(`${path}:${i + 1}: ${line.trim()}`);
		}
	}

	assert.deepStrictEqual(
		offenders,
		[],
		`${offenders.length} reference(s) still name the legacy sandbox directory "${LEGACY}".\n` +
			`The directory name is ALSO the public URL the browser client fetches its config from, so a partial\n` +
			`rename leaves a deployed page unable to resolve its API URL. Rename every site below, or — if the\n` +
			`mention is a record of the past — name the file in HISTORICAL_FILES with a reason.\n\n` +
			`${offenders.join('\n')}\n`,
	);
});

/**
 * The sites that had to move as ONE unit: the disk constant, the URL constant, the
 * published CloudFront behaviour and its invalidation paths, the S3 key prefix, the
 * dual-purpose build-output site that is both a disk path and the S3 key, the
 * browser fetch, the dev server's local mirror of the published path, both committed
 * Next.js route directories, and the gitignore pair that keeps those routes
 * committed while ignoring the state directory.
 */
const COUPLED_SITES: ReadonlyArray<{
	readonly site: string;
	readonly file: string;
	readonly needle: string;
	readonly why: string;
}> = [
	{
		site: 'disk constant',
		file: 'packages/core/src/common/constants.ts',
		needle: `export const BLOCKS_SANDBOX_DIR = '${CURRENT}';`,
		why: 'the on-disk state directory every script reads and writes',
	},
	{
		site: 'URL constant',
		file: 'packages/core/src/constants.ts',
		needle: `export const BLOCKS_SANDBOX_PREFIX = '/${CURRENT}';`,
		why: 'the served path the dev server answers, mirroring CloudFront',
	},
	{
		site: 'CloudFront static behaviour',
		file: 'packages/core/src/hosting.ts',
		needle: `pattern: \`/\${BLOCKS_SANDBOX_DIR}/*\``,
		why: 'publishes the config path from S3 instead of routing it to compute',
	},
	{
		site: 'S3 key prefix',
		file: 'packages/core/src/hosting.ts',
		needle: 'const configKeyPrefix = hosting.websiteBucket ? BLOCKS_SANDBOX_DIR',
		why: 'the key the resolved config is uploaded to — it IS the URL path',
	},
	{
		site: 'CloudFront invalidation paths',
		file: 'packages/core/src/hosting.ts',
		needle: 'distributionPaths: [`/builds/${buildId}/${BLOCKS_SANDBOX_DIR}/*`',
		why: 'a redeploy must clear the edge entry at the path it actually publishes',
	},
	{
		site: 'build-output coupling site',
		file: 'packages/core/src/hosting.ts',
		needle: 'const blocksSandboxDir = join(staticDir, BLOCKS_SANDBOX_DIR);',
		why: 'a path on disk that becomes the S3 key, hence the URL — both roles at once',
	},
	{
		site: 'browser fetch',
		file: 'packages/core/src/client/index.ts',
		needle: 'await fetch(`${BLOCKS_SANDBOX_PREFIX}/config.json`)',
		why: 'the request a deployed page makes to resolve its API URL',
	},
	{
		site: 'static-asset exclusion',
		file: 'packages/hosting/src/constructs/s3_website_construct.ts',
		needle: `exclude: ['${CURRENT}/*'`,
		why: 'keeps the build-time placeholder from clobbering the real config',
	},
	{
		site: 'root gitignore: ignore the state directory',
		file: '.gitignore',
		needle: `${CURRENT}/`,
		why: 'per-deploy, account-specific state must never be committed',
	},
	{
		site: 'root gitignore: keep the committed route directories',
		file: '.gitignore',
		needle: `!/packages/create-blocks-app/templates/*/src/app/${CURRENT}/`,
		why: 'without this negation the template route silently stops being committed, and a scaffolded app 404s on its own config',
	},
	{
		site: 'root gitignore: keep ignoring the pre-rename directory',
		file: '.gitignore',
		needle: `${LEGACY}/`,
		why: 'the migration copies state forward rather than moving it, so an upgraded checkout still holds the old directory — dropping this ignore makes a developer able to commit their own sandbox id and deployment records',
	},
];

test('every coupled site carries the current name', () => {
	const missing: string[] = [];

	for (const { site, file, needle, why } of COUPLED_SITES) {
		const text = readText(file);
		if (text === null) {
			missing.push(`${site} — ${file} is missing or unreadable`);
			continue;
		}
		if (!text.includes(needle))
			missing.push(`${site} — ${file} does not contain ${JSON.stringify(needle)} (${why})`);
	}

	assert.deepStrictEqual(
		missing,
		[],
		`${missing.length} coupled site(s) did not move with the rename:\n\n${missing.join('\n')}\n\n` +
			`These sites share one name across disk and URL. Leaving any one behind breaks the published config path.\n`,
	);
});

test('the disk constant and the served-path constant name the same directory', () => {
	const disk = readText('packages/core/src/common/constants.ts') ?? '';
	const url = readText('packages/core/src/constants.ts') ?? '';

	const diskMatch = disk.match(/export const BLOCKS_SANDBOX_DIR = '([^']+)';/);
	const urlMatch = url.match(/export const BLOCKS_SANDBOX_PREFIX = '([^']+)';/);

	assert.ok(diskMatch, 'BLOCKS_SANDBOX_DIR declaration not found in packages/core/src/common/constants.ts');
	assert.ok(urlMatch, 'BLOCKS_SANDBOX_PREFIX declaration not found in packages/core/src/constants.ts');
	assert.strictEqual(
		urlMatch[1],
		`/${diskMatch[1]}`,
		`BLOCKS_SANDBOX_PREFIX (${urlMatch[1]}) is not BLOCKS_SANDBOX_DIR (${diskMatch[1]}) served at the root.\n` +
			`The Hosting construct publishes the directory under its own name, so the served path is the disk name\n` +
			`with a leading slash. If these diverge, the browser fetches a path nothing publishes.`,
	);
});

/** The served route is a committed directory whose NAME is the URL, in both the template and its test-app twin. */
const SERVED_ROUTE_DIRS: readonly string[] = [
	`packages/create-blocks-app/templates/nextjs/src/app/${CURRENT}/config.json/route.ts`,
	`test-apps/hosting-ssr/src/app/${CURRENT}/config.json/route.ts`,
];

test('the committed served-route directories are renamed, and read the renamed directory', () => {
	for (const route of SERVED_ROUTE_DIRS) {
		assert.ok(
			existsSync(join(repoRoot, route)),
			`${route} is missing. The directory NAME under src/app is the URL the route answers, so it renames with the served path.`,
		);
		const text = readText(route) ?? '';
		assert.ok(
			text.includes(`'${CURRENT}'`),
			`${route} does not read "${CURRENT}" from disk. The directory name sets the URL and this literal sets the file it reads; they are separate strings and both must move.`,
		);
	}
});
