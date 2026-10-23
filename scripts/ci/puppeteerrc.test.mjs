// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests the gate in .puppeteerrc.cjs: Puppeteer skips its browser download
// only on GitHub Actions and only for an install under the repo's own
// node_modules, so an app scaffolded inside the checkout still gets its
// browser. The file is copied into a temporary tree, which then stands in
// for the repo root (the gate compares the install's cwd with the file's
// directory). The tree is checked by loading the file directly and, when
// Puppeteer is installed, through Puppeteer's own config lookup.
//
// Run: node --test scripts/ci/puppeteerrc.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RC = fileURLToPath(new URL('../../.puppeteerrc.cjs', import.meta.url));
const requireFromRoot = createRequire(new URL('../../package.json', import.meta.url));

/**
 * Puppeteer's config loader from the repo's own install, through Puppeteer's
 * exports map; null when Puppeteer isn't installed (it is only there through
 * md-to-pdf and mermaid-cli). Once Puppeteer is installed, a loader it no
 * longer exports throws here and fails the run instead of skipping it.
 */
function resolveGetConfiguration() {
	try {
		requireFromRoot.resolve('puppeteer');
	} catch {
		return null;
	}
	return requireFromRoot.resolve('puppeteer/internal/getConfiguration.js');
}
const GET_CONFIGURATION = resolveGetConfiguration();

const root = mkdtempSync(join(tmpdir(), 'puppeteerrc-'));
after(() => rmSync(root, { recursive: true, force: true }));
copyFileSync(RC, join(root, '.puppeteerrc.cjs'));
const installs = {
	'the repo node_modules': join(root, 'node_modules', 'puppeteer'),
	'an app inside the repo': join(root, 'test-apps', 'x', 'node_modules', 'puppeteer'),
	'the repo root': root,
};
for (const dir of Object.values(installs)) mkdirSync(dir, { recursive: true });

/** `skipDownload` as Puppeteer itself resolves it for an install running in `cwd` on GitHub Actions. */
function puppeteerSkips(cwd) {
	// HOME and XDG_CONFIG_HOME point into the tree: Puppeteer also reads a
	// per-user config there, which a developer's own would otherwise override.
	const env = { ...process.env, GITHUB_ACTIONS: 'true', GET_CONFIGURATION, HOME: root, XDG_CONFIG_HOME: root };
	for (const name of Object.keys(env)) if (name.startsWith('PUPPETEER_')) delete env[name];
	const r = spawnSync(
		process.execPath,
		['-p', 'JSON.stringify(require(process.env.GET_CONFIGURATION).getConfiguration().skipDownload ?? null)'],
		{ cwd, env, encoding: 'utf8' },
	);
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout);
}

/** What the config file exports when Puppeteer's install runs in `cwd`. */
function config(cwd, githubActions) {
	const env = { ...process.env, RC: join(root, '.puppeteerrc.cjs') };
	delete env.GITHUB_ACTIONS;
	if (githubActions !== undefined) env.GITHUB_ACTIONS = githubActions;
	const r = spawnSync(process.execPath, ['-p', 'JSON.stringify(require(process.env.RC) ?? null)'], {
		cwd,
		env,
		encoding: 'utf8',
	});
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout);
}

describe('.puppeteerrc.cjs', () => {
	it('skips the download for an install under the repo node_modules on GitHub Actions', () => {
		assert.deepEqual(config(installs['the repo node_modules'], 'true'), { skipDownload: true });
	});

	for (const [where, cwd] of Object.entries(installs)) {
		for (const githubActions of [undefined, 'false']) {
			it(`exports nothing for ${where} with GITHUB_ACTIONS ${githubActions ?? 'unset'}`, () => {
				assert.equal(config(cwd, githubActions), null);
			});
		}
		if (where !== 'the repo node_modules') {
			it(`exports nothing for ${where} on GitHub Actions`, () => {
				assert.equal(config(cwd, 'true'), null);
			});
		}
	}

	// The checks above load the file directly; this one goes through
	// Puppeteer's own lookup, so a Puppeteer upgrade that stops finding or
	// honouring the file fails here.
	it(
		"skips the download through Puppeteer's own config lookup only for the repo node_modules",
		{ skip: GET_CONFIGURATION ? false : 'Puppeteer is not installed' },
		() => {
			assert.equal(puppeteerSkips(installs['the repo node_modules']), true);
			assert.equal(puppeteerSkips(installs['an app inside the repo']), null);
			assert.equal(puppeteerSkips(installs['the repo root']), null);
		},
	);
});
