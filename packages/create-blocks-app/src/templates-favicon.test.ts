// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every template that serves a frontend ships a favicon. Without one, the
 * browser requests `/favicon.ico` on every page load and the dev server (and
 * the deployed site) answers 404, which shows up as a console error in a
 * freshly scaffolded app.
 *
 * - Vite templates (an `index.html` at the root) ship `public/favicon.svg` and
 *   link it from `index.html`. Vite serves `public/` at `/` in dev and copies
 *   it into `dist/` on build.
 * - Next.js templates ship `src/app/icon.svg`. The App Router file convention
 *   emits the `<link rel="icon">` tag itself.
 *
 * A template serves a frontend when its `package.json` has a `blocks.dev`
 * block without `"frontend": false` (overlays such as `amplify` have no
 * `blocks.dev` and no frontend of their own).
 */

import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

interface TemplatePackage {
	blocks?: { dev?: { frontend?: boolean } };
}

/**
 * A directory without a `package.json` is not a template, so it is skipped
 * rather than crashing the whole suite at load time.
 */
function isFrontendTemplate(dir: string): boolean {
	const manifest = join(dir, 'package.json');
	if (!existsSync(manifest)) return false;
	const pkg: TemplatePackage = JSON.parse(readFileSync(manifest, 'utf8'));
	return pkg.blocks?.dev !== undefined && pkg.blocks.dev.frontend !== false;
}

const frontendTemplates = readdirSync(templatesDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.filter((name) => isFrontendTemplate(join(templatesDir, name)));

function assertSvg(path: string): void {
	assert.ok(existsSync(path), `missing ${path}`);
	const svg = readFileSync(path, 'utf8');
	assert.match(svg, /^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${path} is not a standalone SVG`);
	assert.match(svg, /<\/svg>\s*$/, `${path} is not a complete SVG`);
}

describe('template favicons', () => {
	it('finds the frontend templates (guards the filter itself)', () => {
		for (const name of ['default', 'react', 'nextjs']) {
			assert.ok(frontendTemplates.includes(name), `${name} should count as a frontend template`);
		}
		assert.ok(!frontendTemplates.includes('backend'), 'backend has no frontend');
	});

	it('skips a directory without a package.json instead of throwing', () => {
		const root = mkdtempSync(join(tmpdir(), 'favicon-filter-'));
		try {
			const stray = join(root, 'not-a-template');
			mkdirSync(stray);
			assert.strictEqual(isFrontendTemplate(stray), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	for (const name of frontendTemplates) {
		it(`${name} ships a favicon`, () => {
			const dir = join(templatesDir, name);
			const indexHtml = join(dir, 'index.html');
			if (existsSync(indexHtml)) {
				assertSvg(join(dir, 'public', 'favicon.svg'));
				assert.match(
					readFileSync(indexHtml, 'utf8'),
					/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"\s*\/?>/,
					`${name}/index.html should link /favicon.svg`,
				);
			} else {
				assert.ok(existsSync(join(dir, 'src', 'app', 'layout.tsx')), `${name} is neither Vite nor Next.js`);
				assertSvg(join(dir, 'src', 'app', 'icon.svg'));
			}
		});
	}
});
