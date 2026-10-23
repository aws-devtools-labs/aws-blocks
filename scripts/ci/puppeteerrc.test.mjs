// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests the gate in .puppeteerrc.cjs: Puppeteer skips its browser download
// only on GitHub Actions and only for an install under the repo's own
// node_modules, so an app scaffolded inside the checkout still gets its
// browser. The file is copied into a temporary tree, which then stands in
// for the repo root (the gate compares the install's cwd with the file's
// directory).
//
// Run: node --test scripts/ci/puppeteerrc.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RC = fileURLToPath(new URL('../../.puppeteerrc.cjs', import.meta.url));

const root = mkdtempSync(join(tmpdir(), 'puppeteerrc-'));
copyFileSync(RC, join(root, '.puppeteerrc.cjs'));
const installs = {
	'the repo node_modules': join(root, 'node_modules', 'puppeteer'),
	'an app inside the repo': join(root, 'test-apps', 'x', 'node_modules', 'puppeteer'),
	'the repo root': root,
};
for (const dir of Object.values(installs)) mkdirSync(dir, { recursive: true });

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
});
