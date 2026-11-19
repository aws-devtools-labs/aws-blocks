// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard: the sandbox state directory finished its rename.
 *
 * The directory holding an app's per-deploy state moved from `.blocks-sandbox` to
 * `.cdk-blocks-sandbox` for the CDK Blocks rebrand. The PUBLISHED path did not move
 * with it — it is a public URL an already-deployed frontend asks for, so it stayed
 * (D-031), and it is guarded separately in `sandbox-url-decoupling.test.ts`.
 *
 * That leaves the old string legitimately live, which is what shapes this guard. It
 * cannot simply forbid the old name: a test spells both, because it asserts on each.
 * So the scan is scoped to SHIPPED SOURCE, where the rule is exact — product code
 * reaches for a constant, and only two declarations may name the old string: the
 * migration's source directory and the published directory.
 *
 * The rename itself was never type-checked. The overwhelming majority of references
 * were hardcoded literals in templates, test apps, gitignores, `cdk.json`
 * watch-excludes and CI workflows, so renaming the constants compiled clean while
 * hundreds of literals still said the old name. The `aws-blocks/` → `cdk-blocks/`
 * rename broke 24 tests the same way.
 *
 * It checks two things:
 *
 *  1. No filesystem path in shipped source still names the old directory. A missed
 *     one reads or writes a directory the current toolchain does not maintain — for
 *     `sandbox-id.txt` that means minting a new id and orphaning the customer's
 *     stack.
 *
 *  2. Every site that had to move carries the new name, pinned by surrounding content
 *     rather than by line number, so a deleted edit fails as loudly as a stale one.
 *
 * It is a TEXT scan, not a runtime import: most of the surface is JSON, YAML,
 * gitignores and template files that no import can reach.
 *
 * Run: node --test dist/sandbox-dir-coverage.test.js
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(pkgRoot, '..', '..');

/**
 * The ON-DISK directory this repo uses now. The PUBLISHED path is deliberately
 * still the old name and is guarded separately (`sandbox-url-decoupling.test.ts`,
 * D-031), so this file no longer asserts anything about the served path.
 */
const CURRENT = '.cdk-blocks-sandbox';

/** The name it was renamed FROM. Spelled in pieces so this file is not itself a hit. */
const LEGACY = `.blocks${'-'}sandbox`;

/**
 * The one declaration allowed to name the legacy directory in shipped source: the
 * migration reads the old location to copy state forward (D-031). Any OTHER
 * occurrence in a shipped `src` tree is a missed rename.
 */
const LEGACY_CONSTANT = 'LEGACY_SANDBOX_DIR';

/**
 * The other declaration allowed to name it: the PUBLISHED directory, which kept the
 * old name on purpose because it is a public URL an already-deployed frontend asks
 * for (D-031). Guarded in `sandbox-url-decoupling.test.ts`.
 */
const SERVED_CONSTANT = 'BLOCKS_SANDBOX_SERVED_DIR';

/**
 * Shipped source naming the published path as TEXT: a comment has no interpolation to
 * make, and `@aws-cdk-blocks/hosting` cannot import the constant at all. Each entry is safe
 * only because the file has no disk-facing sandbox path to confuse it with, which
 * `sandbox-url-decoupling.test.ts` asserts. Do not add a file that touches both.
 */
const SERVED_PATH_AS_TEXT: Record<string, string> = {
	'packages/hosting/src/': 'does not depend on core, so it cannot interpolate the served-path constant at all',
	'packages/core/src/hosting.ts':
		'comments and JSDoc describing the published path, including the customer-facing warning',
	'packages/core/src/scripts/wait-live.ts': 'comments describing the published path it probes',
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

test('shipped source names the pre-rename directory only where it must', () => {
	const offenders: string[] = [];

	// Scoped to shipped source: a test spells both names, so a scan over tests could not
	// tell a missed rename from a deliberate published path.
	for (const path of trackedFiles()) {
		if (!/^packages\/[^/]+\/src\//.test(path) || path.includes('.test.')) continue;
		if (Object.keys(SERVED_PATH_AS_TEXT).some((prefix) => path.startsWith(prefix))) continue;

		const text = readText(path);
		if (text === null || !text.includes(LEGACY)) continue;

		for (const [i, line] of text.split('\n').entries()) {
			if (!line.includes(LEGACY)) continue;
			// The migration's source directory, and the published directory (D-031).
			if (line.includes(LEGACY_CONSTANT) || line.includes(SERVED_CONSTANT)) continue;
			offenders.push(`${path}:${i + 1}: ${line.trim()}`);
		}
	}

	assert.deepStrictEqual(
		offenders,
		[],
		`${offenders.length} line(s) of shipped source name "${LEGACY}" outside the two declarations allowed to.\n` +
			`The state directory moved to "${CURRENT}"; only the PUBLISHED path kept the old name, and it is read\n` +
			`through ${SERVED_CONSTANT}. A literal anywhere else is either a missed disk rename — which for the\n` +
			`sandbox id means minting a new one and orphaning the customer's stack — or a published path that\n` +
			`should be reading the constant.\n\n${offenders.join('\n')}\n`,
	);
});

/**
 * The sites the rename had to move, pinned by content: the disk constant itself, and
 * the three gitignore entries that decide what is committable — the state directory
 * ignored under its new name, the pre-rename directory still ignored because the
 * migration leaves it on disk, and the negation that keeps the template's route
 * directory committed. The publishing sites are pinned in
 * `sandbox-url-decoupling.test.ts` instead, since they follow the served name.
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
		site: 'root gitignore: ignore the state directory',
		file: '.gitignore',
		needle: `${CURRENT}/`,
		why: 'per-deploy, account-specific state must never be committed',
	},
	{
		site: 'root gitignore: keep the committed route directories',
		file: '.gitignore',
		needle: `!/packages/create-blocks-app/templates/*/src/app/${LEGACY}/`,
		why: "the route directory's name is the PUBLISHED path, which kept the old name (D-031); without this negation the template route silently stops being committed and a scaffolded app 404s on its own config",
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

/** The served route is a committed directory whose NAME is the URL, in both the template and its test-app twin. */
const SERVED_ROUTE_DIRS: readonly string[] = [
	`packages/create-blocks-app/templates/nextjs/src/app/${LEGACY}/config.json/route.ts`,
	`test-apps/hosting-ssr/src/app/${LEGACY}/config.json/route.ts`,
];

test('the committed served-route directories keep the published name and read the renamed directory', () => {
	for (const route of SERVED_ROUTE_DIRS) {
		assert.ok(
			existsSync(join(repoRoot, route)),
			`${route} is missing. The directory NAME under src/app is the URL the route answers, so it follows the PUBLISHED path, which kept the old name (D-031).`,
		);
		const text = readText(route) ?? '';
		assert.ok(
			text.includes(`'${CURRENT}'`),
			`${route} does not read "${CURRENT}" from disk. The directory name sets the URL and this literal sets the file it reads; they are separate strings and both must move.`,
		);
	}
});
