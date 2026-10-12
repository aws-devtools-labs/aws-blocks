// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Checks that every asset directory a publishable package's compiled code loads
 * with `Code.fromAsset(join(__dirname, '<dir>'))` is in that package's npm pack
 * listing.
 *
 * Such a directory comes from a package-local bundle step (esbuild into
 * `dist/<dir>/`). The release runs only the root `npm run build`, so a bundle
 * step the root build skips still leaves a green build, and a `pretest` hook that
 * bundles hides the gap from CI. The package then publishes without the asset and
 * `cdk synth` in a consumer app fails with CannotFindAsset.
 *
 * Run after `npm run build` and before any test step.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGES_DIR = join(ROOT, 'packages');

/** `Code.fromAsset(join(__dirname, 'dir'))`, also as `path.join(...)`. Group 2 is the directory. */
const ASSET_REF = /Code\.fromAsset\(\s*(?:path\.)?join\(\s*__dirname\s*,\s*(['"])([^'"]+)\1\s*\)/g;

interface AssetRef {
	/** Package-relative path of the compiled file holding the reference. */
	file: string;
	/** Package-relative path of the asset directory it loads. */
	asset: string;
}

function walkJsFiles(dir: string, acc: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'node_modules') walkJsFiles(full, acc);
		} else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
			acc.push(full);
		}
	}
}

function findAssetRefs(pkgDir: string): AssetRef[] {
	const distDir = join(pkgDir, 'dist');
	if (!existsSync(distDir)) return [];
	const files: string[] = [];
	walkJsFiles(distDir, files);
	const refs: AssetRef[] = [];
	for (const abs of files.sort()) {
		const file = relative(pkgDir, abs).split(sep).join('/');
		for (const match of readFileSync(abs, 'utf-8').matchAll(ASSET_REF)) {
			refs.push({ file, asset: posix.normalize(posix.join(posix.dirname(file), match[2])) });
		}
	}
	return refs;
}

/** The package-relative paths `npm pack` would publish. */
function packedFiles(pkgDir: string): string[] {
	const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
		cwd: pkgDir,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const [entry] = JSON.parse(out) as { files: { path: string }[] }[];
	return entry.files.map((f) => f.path);
}

function main(): number {
	const offenders: string[] = [];
	let checked = 0;

	for (const name of readdirSync(PACKAGES_DIR).sort()) {
		const pkgDir = join(PACKAGES_DIR, name);
		const manifestPath = join(pkgDir, 'package.json');
		if (!existsSync(manifestPath)) continue;
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { name?: string; private?: boolean };
		if (manifest.private) continue;

		const refs = findAssetRefs(pkgDir);
		if (refs.length === 0) continue;

		const packed = packedFiles(pkgDir);
		for (const { file, asset } of refs) {
			checked++;
			if (packed.some((p) => p.startsWith(`${asset}/`))) {
				console.log(`  ✓ ${manifest.name ?? name}: ${asset}/ (${file})`);
			} else {
				console.log(`  ✗ ${manifest.name ?? name}: ${asset}/ (${file})`);
				offenders.push(`${manifest.name ?? name}: ${file} loads ${asset}/, which the packed tarball does not contain`);
			}
		}
	}

	console.log();

	if (checked === 0) {
		console.error('ERROR: found no Code.fromAsset(join(__dirname, ...)) references under packages/*/dist.');
		console.error('Run `npm run build` first.');
		return 1;
	}

	if (offenders.length > 0) {
		console.error('ERRORS:');
		for (const err of offenders) console.error(`  • ${err}`);
		console.error(
			'\nThe release publishes what root `npm run build` produces. Add the step that writes each missing ' +
				'directory to the root `build:bundles` script.',
		);
		return 1;
	}

	console.log(`All ${checked} asset reference(s) are in their package's pack listing.`);
	return 0;
}

process.exit(main());
