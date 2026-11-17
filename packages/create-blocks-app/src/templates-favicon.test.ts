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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

interface TemplatePackage {
	blocks?: { dev?: { frontend?: boolean } };
}

const frontendTemplates = readdirSync(templatesDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.filter((name) => {
		const pkg: TemplatePackage = JSON.parse(readFileSync(join(templatesDir, name, 'package.json'), 'utf8'));
		return pkg.blocks?.dev !== undefined && pkg.blocks.dev.frontend !== false;
	});

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
