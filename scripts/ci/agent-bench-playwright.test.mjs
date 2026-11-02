// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for the Playwright pin in scripts/ci/agent-bench-playwright, which agent-bench's browser
// pre-provision installs with `npm ci` instead of running `npx playwright@<version>` from the
// restored npm cache. They fail a PR (including one that only bumps PW_VERSION) when:
//   - the pin, its lockfile and the verifier's PW_VERSION
//     (scripts/agent-bench/steps/3-build-and-test.sh) disagree, so the pre-provisioned browser
//     would not be the one the verifier uses;
//   - a lockfile entry lacks an integrity hash, so `npm ci` could not verify it;
//   - agent-bench.yml stops installing from the pin or goes back to npx for Playwright.
//
// Run: node --test scripts/ci/agent-bench-playwright.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(`${ROOT}${rel}`, 'utf8');
const PIN = 'scripts/ci/agent-bench-playwright';
const pkg = JSON.parse(read(`${PIN}/package.json`));
const lock = JSON.parse(read(`${PIN}/package-lock.json`));

describe('agent-bench Playwright pin', () => {
	const version = pkg.dependencies?.playwright;

	it('pins one exact playwright version in a private package', () => {
		assert.equal(pkg.private, true);
		assert.match(version ?? '', /^\d+\.\d+\.\d+$/, 'dependencies.playwright must be an exact version');
		assert.deepEqual(Object.keys(pkg.dependencies), ['playwright']);
	});

	it('matches the verifier PW_VERSION', () => {
		const pw = /^PW_VERSION="([^"]+)"$/m.exec(read('scripts/agent-bench/steps/3-build-and-test.sh'))?.[1];
		assert.ok(pw, 'PW_VERSION="<version>" not found in 3-build-and-test.sh');
		assert.equal(version, pw);
	});

	it('has a lockfile that resolves the same version with integrity for every entry', () => {
		assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies, 'lockfile out of date: run npm install there');
		assert.equal(lock.packages['node_modules/playwright']?.version, version);
		assert.equal(lock.packages['node_modules/playwright-core']?.version, version);
		for (const [path, entry] of Object.entries(lock.packages)) {
			if (path === '') continue;
			assert.match(entry.integrity ?? '', /^sha512-/, `${path} has no sha512 integrity`);
			assert.ok(entry.resolved?.startsWith('https://registry.npmjs.org/'), `${path} resolves outside the npm registry`);
		}
	});

	it('is not a root workspace (workspace bumps would move it)', () => {
		const workspaces = JSON.parse(read('package.json')).workspaces;
		assert.ok(!workspaces.some((w) => w.startsWith(PIN)), `${PIN} is listed in the root workspaces`);
	});
});

describe('agent-bench.yml installs Playwright from the pin', () => {
	const steps = parse(read('.github/workflows/agent-bench.yml')).jobs.bench.steps;
	const runs = steps.filter((s) => typeof s.run === 'string');
	// Shell lines with `\` continuations joined and comment lines dropped.
	const lines = runs.flatMap((s) => s.run.replace(/\\\n\s*/g, ' ').split('\n').filter((l) => !l.trim().startsWith('#')));

	it('runs npm ci from the pin lockfile', () => {
		const pin = steps.find((s) => s.id === 'pwpin');
		assert.ok(pin, 'no step with id: pwpin');
		assert.match(pin.run, new RegExp(`^\\s*npm ci --prefix ${PIN} --ignore-scripts\\b`, 'm'));
		assert.match(pin.run, /--fetch-timeout=\d+ --fetch-retries=\d+/, 'npm fetch bounds keep it inside the step cap');
		assert.ok(Number(pin['timeout-minutes']) > 0, 'pwpin needs a timeout-minutes');
	});

	it('installs the browser with the pinned bin, after the pin installs', () => {
		const provision = steps.find((s) => s.id === 'pwprovision');
		assert.ok(provision, 'no step with id: pwprovision');
		assert.equal(provision.if, "steps.pwpin.outcome == 'success'");
		assert.match(
			provision.run,
			new RegExp(`^\\s*node scripts/ci/install-playwright\\.mjs --bin ${PIN}/node_modules/\\.bin/playwright chromium$`, 'm'),
		);
		assert.ok(steps.indexOf(steps.find((s) => s.id === 'pwpin')) < steps.indexOf(provision));
	});

	it('never resolves Playwright through npx', () => {
		const bad = lines.filter((l) => /\b(npx|npm\s+exec|npm\s+x)\b.*\bplaywright\b/.test(l) || /--package[\s=]+playwright/.test(l));
		assert.deepEqual(bad, []);
	});

	it('runs the install wrapper only with the pinned --bin (its default is npx)', () => {
		const wrapper = lines.filter((l) => l.includes('install-playwright.mjs'));
		assert.ok(wrapper.length >= 1);
		const pinned = new RegExp(`--bin ${PIN}/node_modules/\\.bin/playwright(\\s|$)`);
		for (const l of wrapper) assert.ok(pinned.test(l) && l.split('--bin').length === 2, l);
	});
});
