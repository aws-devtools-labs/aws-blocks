// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard: the PUBLISHED path and the ON-DISK directory must never be
 * derived from the same constant.
 *
 * These two look identical as text and are not the same thing:
 *
 *  - the on-disk directory ({@link BLOCKS_SANDBOX_DIR}) is private to the
 *    developer's machine. Renaming it costs an upgrading app a state copy, which
 *    the migration performs, and nothing already deployed can notice.
 *  - the served path ({@link BLOCKS_SANDBOX_SERVED_DIR}) is a public URL that a
 *    customer's ALREADY-DEPLOYED frontend bundle asks for. Renaming it breaks
 *    that page until the customer redeploys, and a browser or CloudFront cache
 *    can hold the stale request past the deploy (D-031).
 *
 * One constant serving both makes the cheap rename and the breaking one the same
 * edit, which is how the published path moved in the first place. So the rule is
 * structural rather than advisory: a site that builds a URL, a CloudFront
 * behaviour, an invalidation path, or the S3 key the config is published under
 * must read the SERVED constant, and a site that touches the developer's disk
 * must read the DISK constant.
 *
 * The trap is that one site is BOTH: the hosting construct writes a placeholder
 * into the static-asset directory on disk, and that path becomes the S3 key, so
 * it is published. It must follow the SERVED name even though it is a disk write.
 *
 * This is a TEXT scan, because the thing being checked is which identifier the
 * author reached for — a type cannot distinguish two strings.
 *
 * Run: node --test dist/sandbox-url-decoupling.test.js
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(pkgRoot, '..', '..');

/** The developer's private state directory. */
const DISK_CONST = 'BLOCKS_SANDBOX_DIR';

/** The published directory name, without its leading slash. */
const SERVED_CONST = 'BLOCKS_SANDBOX_SERVED_DIR';

/** The published path, with its leading slash. */
const PREFIX_CONST = 'BLOCKS_SANDBOX_PREFIX';

const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf-8');

/** The on-disk directory's literal value, for the prose check below. */
const DISK_DIR = '.cdk-blocks-sandbox';

/**
 * {@link BLOCKS_SANDBOX_SERVED_DIR}'s value, read from its declaration. Every site
 * interpolates the constant except hosting's S3 exclude, which cannot import it;
 * deriving the expected text from here is what keeps that pair self-checking.
 */
const SERVED_DIR = (() => {
	const match = readFileSync(join(repoRoot, 'packages/core/src/common/constants.ts'), 'utf-8').match(
		new RegExp(`export const ${SERVED_CONST} = '([^']+)';`),
	);
	if (!match) throw new Error(`${SERVED_CONST} declaration not found in packages/core/src/common/constants.ts`);
	return match[1];
})();

/**
 * Files whose every sandbox path is a published one: they import the served constant
 * and never the disk constant, so a mention of the disk directory in them — code or
 * comment — is stale.
 */
const PUBLISHED_ONLY_FILES: readonly string[] = [
	'packages/core/src/hosting.ts',
	'packages/core/src/scripts/wait-live.ts',
];

/**
 * Every tracked file that can carry a URL: source, published docs, scripts, CI and app
 * pages. Deliberately not just `.ts` — scanning only shipped TypeScript left 27 stale
 * URL references, including two published docs and four live `fetch` calls. Generated
 * doc copies are excluded; a stale copy is fixed by regenerating it.
 */
function urlBearingFiles(): string[] {
	const out = execFileSync('git', ['ls-files', '-z'], {
		cwd: repoRoot,
		encoding: 'utf-8',
		maxBuffer: 64 * 1024 * 1024,
	});
	return out
		.split('\0')
		.filter((p) => p.length > 0)
		.filter((p) => /\.(ts|tsx|mts|mjs|js|jsx|vue|svelte|astro|md|mdx|sh|yml|yaml)$/.test(p))
		.filter((p) => !p.endsWith('CHANGELOG.md') && !p.startsWith('packages/blocks/docs/'));
}

/**
 * Every site that writes something a customer's browser can reach: a CloudFront
 * behaviour, an invalidation path, the S3 key the runtime config is published
 * under, the no-cache path registered for that key, the liveness probe's URL, and
 * the placeholder write whose on-disk path becomes that same S3 key.
 *
 * Each is pinned by the surrounding code rather than by line number, so an edit
 * that swaps the constant fails here and names the site.
 */
const PUBLISHED_SITES: ReadonlyArray<{
	readonly site: string;
	readonly file: string;
	readonly needle: string;
	readonly why: string;
}> = [
	{
		site: 'CloudFront static behaviour',
		file: 'packages/core/src/hosting.ts',
		needle: `pattern: \`/\${${SERVED_CONST}}/*\``,
		why: 'the path CloudFront publishes from S3 instead of routing to compute',
	},
	{
		site: 'S3 key prefix for the resolved config',
		file: 'packages/core/src/hosting.ts',
		needle: `const configKeyPrefix = hosting.websiteBucket ? ${SERVED_CONST}`,
		why: 'the key the config is uploaded to — it IS the URL the browser asks for',
	},
	{
		site: 'CloudFront invalidation paths',
		file: 'packages/core/src/hosting.ts',
		needle: `distributionPaths: [\`/builds/\${buildId}/\${${SERVED_CONST}}/*\``,
		why: 'a redeploy must clear the edge entry at the path it actually publishes',
	},
	{
		site: 'no-cache path for the published config',
		file: 'packages/core/src/hosting.ts',
		needle: `const configNoCachePath = \`\${${SERVED_CONST}}/config.json\`;`,
		why: 'registered against the published key, so an edge never caches it long-term',
	},
	{
		site: 'placeholder write (disk path that becomes the S3 key)',
		file: 'packages/core/src/hosting.ts',
		needle: `const blocksSandboxDir = join(staticDir, ${SERVED_CONST});`,
		why: 'a disk write whose path is published verbatim — the one site that is both',
	},
	{
		site: 'liveness probe path',
		file: 'packages/core/src/scripts/wait-live.ts',
		needle: `export const CONFIG_PROBE_PATH = \`/\${${SERVED_CONST}}/config.json\`;`,
		why: 'fetched over HTTP from the deployed origin, so it is the published path',
	},
	{
		site: 'SSR middleware matcher exclusion',
		file: 'test-apps/hosting-ssr/src/middleware.ts',
		needle: `|.${'blocks'}-sandbox).*)`,
		why: 'the matcher excludes the published path so middleware does not run on the config request; it names the directory with no leading slash, which the URL-shape scan cannot reach without false positives',
	},
	{
		site: 'browser fetch',
		file: 'packages/core/src/client/index.ts',
		needle: `await fetch(\`\${${PREFIX_CONST}}/config.json\`)`,
		why: "the request a customer's deployed page makes to resolve its API URL",
	},
	{
		site: 'static-asset exclusion for the placeholder',
		file: 'packages/hosting/src/constructs/s3_website_construct.ts',
		needle: `'${SERVED_DIR}/*'`,
		why: "the S3 exclude that stops the build-time placeholder overwriting the real config. A literal, because `@aws-cdk-blocks/hosting` cannot import the constant, so it is checked against the constant's value — matched without the surrounding `exclude: [` so a reformat of that array cannot fail this spuriously",
	},
	{
		site: 'dev server mirror of the published path',
		file: 'packages/core/src/scripts/dev-server.ts',
		needle: `pathname === \`\${${PREFIX_CONST}}/config.json\``,
		why: 'answers the same path locally, so dev and deployed behave alike',
	},
];

test('no published site derives its path from the on-disk constant', () => {
	const offenders: string[] = [];

	for (const { site, file, needle, why } of PUBLISHED_SITES) {
		const text = read(file);
		if (!text.includes(needle))
			offenders.push(`${site} — ${file} does not contain ${JSON.stringify(needle)} (${why})`);
	}

	assert.deepStrictEqual(
		offenders,
		[],
		`${offenders.length} published site(s) do not read the served-path constant:\n\n${offenders.join('\n')}\n\n` +
			`A published path must come from ${SERVED_CONST} (or ${PREFIX_CONST}), never from ${DISK_CONST}. Deriving a\n` +
			`URL from the disk constant means the next rename of a private directory also renames a public URL, and\n` +
			`every already-deployed frontend stops resolving its API URL until the customer redeploys.\n`,
	);
});

test('the served path and the on-disk directory are different names', () => {
	const common = read('packages/core/src/common/constants.ts');

	const disk = common.match(new RegExp(`export const ${DISK_CONST} = '([^']+)';`));
	const served = common.match(new RegExp(`export const ${SERVED_CONST} = '([^']+)';`));

	assert.ok(disk, `${DISK_CONST} declaration not found`);
	assert.ok(served, `${SERVED_CONST} declaration not found`);
	assert.notStrictEqual(
		served[1],
		disk[1],
		`The served path and the disk directory are both ${JSON.stringify(disk[1])}. They are allowed to differ and\n` +
			`currently must: the disk directory was renamed for the CDK Blocks rebrand while the served path stayed as\n` +
			`it was, so a frontend deployed before the rebrand keeps resolving its API URL (D-031).`,
	);
});

test('the served prefix is derived from the served directory, not spelled twice', () => {
	const constants = read('packages/core/src/constants.ts');

	assert.match(
		constants,
		new RegExp(`export const ${PREFIX_CONST} = \`/\\$\\{${SERVED_CONST}\\}\`;`),
		`${PREFIX_CONST} must be built from ${SERVED_CONST} rather than repeating its value. Two literals for one\n` +
			`published path can drift, and the drift is invisible until a deployed page 404s on its own config.`,
	);
});

test('a file that only publishes never mentions the on-disk directory, in code or prose', () => {
	// A file that reads the served constant and never the disk one has no disk-facing
	// path to preserve, so any mention of the disk directory in it — code or prose — is stale.
	const offenders: string[] = [];

	for (const file of PUBLISHED_ONLY_FILES) {
		const text = read(file);
		if (text.includes(DISK_CONST)) continue; // imports both: a mixed file, not checked here
		for (const [i, line] of text.split('\n').entries()) {
			if (line.includes(DISK_DIR)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
		}
	}

	assert.deepStrictEqual(
		offenders,
		[],
		`${offenders.length} line(s) name the on-disk directory "${DISK_DIR}" in a file that only publishes:\n\n${offenders.join('\n')}\n\n` +
			`These files read ${SERVED_CONST} and never ${DISK_CONST}, so every path they describe is the public one.\n` +
			`A comment or JSDoc naming the disk directory tells a reader the wrong URL.\n`,
	);
});

test('nothing writes a URL-shaped sandbox path on the on-disk name', () => {
	// Covers the mixed files the check above skips. A leading slash alone is not a URL
	// (`${VAR}/.cdk-blocks-sandbox/x` is a path), so require root-relative or an HTTP use.
	const ROOT_RELATIVE = /(^|['"`(,=\s])\/\.cdk-blocks-sandbox/;
	const URL_MARKER = /https?:|fetch\(|curl |distributionPaths|pattern:|behaviors|matcher:|GET \//;

	const offenders: string[] = [];

	for (const file of urlBearingFiles()) {
		const text = read(file);
		if (!text.includes(`/${DISK_DIR}`)) continue;
		for (const [i, line] of text.split('\n').entries()) {
			if (!line.includes(`/${DISK_DIR}`)) continue;
			if (!ROOT_RELATIVE.test(line) && !URL_MARKER.test(line)) continue;
			offenders.push(`${file}:${i + 1}: ${line.trim()}`);
		}
	}

	assert.deepStrictEqual(
		offenders,
		[],
		`${offenders.length} line(s) write "${DISK_DIR}" as a URL path:\n\n${offenders.join('\n')}\n\n` +
			`The published path is "${'/.blocks' + '-sandbox'}"; the disk directory is only ever reached through \`join\`.\n` +
			`Name it with ${PREFIX_CONST} where a constant is available, or correct the text. A published doc or a live\n` +
			`fetch on the disk name sends a customer to a path nothing serves.\n`,
	);
});

test('the migration source is pinned to the name the state directory actually had', () => {
	// It holds the same literal as the served constant by coincidence, so a later rebrand
	// could carry it along by find-and-replace. Pinned independently of both constants.
	const common = read('packages/core/src/common/constants.ts');

	assert.match(
		common,
		/export const LEGACY_SANDBOX_DIR = '\.blocks-sandbox';/,
		`LEGACY_SANDBOX_DIR must stay "${'.blocks' + '-sandbox'}" — the name the state directory had before the rename.\n` +
			`It is the directory the copy-forward reads, so changing it orphans an upgrading app's sandbox id and sends\n` +
			`its next deploy to a different CloudFormation stack. If the served path is being rebranded, change\n` +
			`${SERVED_CONST} and leave this alone.`,
	);
});

test('the gitignore negation for the served route outranks both state-directory ignores', () => {
	const lines = read('.gitignore').split('\n');

	const negation = lines.findIndex(
		(l) => l.trim() === '!/packages/create-blocks-app/templates/*/src/app/.blocks-sandbox/',
	);
	const servedIgnore = lines.findIndex((l) => l.trim() === '.blocks-sandbox/');
	const diskIgnore = lines.findIndex((l) => l.trim() === '.cdk-blocks-sandbox/');

	assert.ok(negation >= 0, 'the negation re-including the template route directory is missing from .gitignore');
	assert.ok(servedIgnore >= 0, 'the ignore for the pre-rename state directory is missing from .gitignore');
	assert.ok(diskIgnore >= 0, 'the ignore for the state directory is missing from .gitignore');

	// Git takes the LAST matching pattern, so the negation only wins if it comes after both.
	assert.ok(
		negation > servedIgnore && negation > diskIgnore,
		`The negation on line ${negation + 1} must come AFTER both state-directory ignores (lines ${servedIgnore + 1} and ${diskIgnore + 1}).\n` +
			`Git takes the last matching pattern, so an earlier negation is overridden and the template's route\n` +
			`directory stops being committed — silently, because the files already tracked keep working while a\n` +
			`newly scaffolded app gets no route and returns 404 on its own config.`,
	);
});
