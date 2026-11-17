// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for .github/actions/e2e-slot (which E2E account a job uses) and for
// how pr-checks.yml's E2E Hosting legs spread over the accounts with it.
//
// Run: node --test scripts/ci/e2e-slot.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const action = parse(readFileSync(join(ROOT, '.github/actions/e2e-slot/action.yml'), 'utf8'));
const pick = action.runs.steps.find((s) => s.id === 'pick');
const ACCOUNTS = Number(pick.env.E2E_ACCOUNTS);
const workflow = parse(readFileSync(join(ROOT, '.github/workflows/pr-checks.yml'), 'utf8'));
const hosting = workflow.jobs['e2e-hosting'];

const dir = mkdtempSync(join(tmpdir(), 'e2e-slot-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Run the action's script as GitHub runs a composite bash step; returns its outputs. */
function slot(prNumber, offset = action.inputs.offset.default) {
	const out = join(dir, `out-${prNumber}-${offset}`);
	const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', pick.run], {
		env: { PATH: process.env.PATH, E2E_ACCOUNTS: String(ACCOUNTS), PR_NUMBER: prNumber, OFFSET: offset, GITHUB_OUTPUT: out },
		encoding: 'utf8',
	});
	if (r.status !== 0) return { status: r.status, stdout: r.stdout };
	const outputs = Object.fromEntries(
		readFileSync(out, 'utf8')
			.trim()
			.split('\n')
			.map((l) => l.split('=')),
	);
	return { status: 0, ...outputs };
}

describe('e2e-slot', () => {
	it('maps a PR to PR number mod the pool size', () => {
		assert.equal(ACCOUNTS, 3, 'update the cases below for the new pool size');
		assert.deepEqual(slot('1203'), { status: 0, index: '0', account: '1', accounts: '3' });
		assert.deepEqual(slot('1204'), { status: 0, index: '1', account: '2', accounts: '3' });
	});

	it('adds the offset before the mod', () => {
		assert.equal(slot('1203', '2').index, '2');
		assert.equal(slot('1204', '2').index, '0');
		assert.equal(slot('1204', '5').index, '0');
		assert.equal(slot('1203', '08').index, '2'); // decimal, not octal
	});

	it('uses account 1, plus the offset, without a PR', () => {
		assert.equal(slot('').index, '0');
		assert.equal(slot('', '1').index, '1');
	});

	it('refuses an offset that is not a whole number', () => {
		for (const bad of ['-1', '1.5', 'x', '']) {
			const r = slot('1203', bad);
			assert.equal(r.status, 1, `offset '${bad}'`);
			assert.match(r.stdout, /::error::e2e-slot offset must be a whole number/);
		}
	});
});

describe('pr-checks.yml E2E Hosting accounts', () => {
	const legs = hosting.strategy.matrix.include;
	const steps = hosting.steps;
	const at = (pred) => steps.findIndex(pred);

	it('gives every leg a fixed offset inside the pool, using every account', () => {
		for (const leg of legs) {
			assert.ok(
				Number.isInteger(leg['account-offset']) && leg['account-offset'] >= 0 && leg['account-offset'] < ACCOUNTS,
				`${leg.framework}: account-offset must be a whole number below ${ACCOUNTS}, got ${leg['account-offset']}`,
			);
		}
		assert.deepEqual(
			[...new Set(legs.map((l) => l['account-offset']))].sort(),
			[...Array(ACCOUNTS).keys()],
			'the legs should spread over every account',
		);
	});

	it("assumes the role of the leg's slot, not the PR's", () => {
		const slotStep = at((s) => s.uses === './.github/actions/e2e-slot');
		const creds = at((s) => s.id === 'aws-creds');
		const checkout = at((s) => s.uses?.startsWith('actions/checkout@'));
		assert.ok(slotStep > checkout, 'the e2e-slot step needs the checkout (a local action)');
		assert.ok(slotStep < creds, 'the e2e-slot step must run before the credentials');
		assert.equal(steps[slotStep].with.offset, '${{ matrix.account-offset }}');
		assert.equal(steps[creds].with.index, `\${{ steps.${steps[slotStep].id}.outputs.index }}`);
		const assumes = steps.filter((s) => s.uses === './.github/actions/e2e-aws-credentials');
		assert.equal(assumes.length, 1, 'every credentials step of the job must use the leg slot');
	});
});
