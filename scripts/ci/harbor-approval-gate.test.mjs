// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for the Harbor agent check's approval gate (.github/workflows/harbor-agent-check.yml).
// Model and trace credentials come from the `harbor-bench` environment, which has no required
// reviewers of its own: the single `approval` job on `harbor-bench-approval` is the only human
// gate, and the IAM roles cannot see it. So the workflows themselves must guarantee that:
//   - no workflow other than harbor-agent-check.yml mentions `harbor-bench` at all (a raw-text
//     check, so it also catches an `environment: ${{ … }}` expression whose values name it);
//   - harbor-agent-check.yml has exactly one approval job, which cannot fan out, skip or succeed
//     without approval;
//   - every job there that uses `harbor-bench` needs it directly;
//   - none of those jobs runs when the approval is rejected or skipped (no always()/failure()).
// It does not catch a name assembled at runtime from parts (e.g. 'harbor-' + 'bench').
//
// Run: node --test scripts/ci/harbor-approval-gate.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const WORKFLOWS = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
const GATED = 'harbor-agent-check.yml';
const jobs = Object.entries(parse(readFileSync(join(WORKFLOWS, GATED), 'utf8')).jobs);
const otherWorkflows = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f) && f !== GATED);

const environmentOf = (job) => (typeof job.environment === 'object' ? job.environment?.name : job.environment);
const needsOf = (job) => [job.needs ?? []].flat();
// Status functions that let a job run although a job it needs failed, was cancelled or was skipped.
const BYPASS = /\b(always|failure|cancelled)\s*\(/;

const approvals = jobs.filter(([, job]) => environmentOf(job) === 'harbor-bench-approval');
const credentialed = jobs.filter(([, job]) => environmentOf(job) === 'harbor-bench');

describe('Harbor approval gate', () => {
	it('keeps harbor-bench out of every other workflow', () => {
		assert.ok(otherWorkflows.length > 0, 'expected other workflow files to scan');
		for (const file of otherWorkflows) {
			assert.ok(
				!readFileSync(join(WORKFLOWS, file), 'utf8').includes('harbor-bench'),
				`${file} mentions harbor-bench; only ${GATED} may use it, behind its approval job`,
			);
		}
	});

	it('has exactly one approval job, which cannot fan out, skip or succeed on error', () => {
		assert.equal(approvals.length, 1, 'expected one job on the harbor-bench-approval environment');
		const [, gate] = approvals[0];
		assert.equal(gate.strategy, undefined, 'the approval job must not be a matrix (one review per run)');
		assert.equal(gate.if, undefined, 'a condition could skip the approval job');
		assert.notEqual(gate['continue-on-error'], true, 'a rejected approval must fail the job');
		assert.deepEqual(gate.permissions, {}, 'the approval job needs no token permissions');
	});

	it('makes every harbor-bench job need the approval job', () => {
		assert.ok(credentialed.length > 0, 'expected at least one job on the harbor-bench environment');
		const [gateName] = approvals[0] ?? [];
		for (const [name, job] of credentialed) {
			assert.ok(needsOf(job).includes(gateName), `${name} uses harbor-bench without needing the approval job`);
		}
	});

	it('never runs a harbor-bench job after a rejected or skipped approval', () => {
		for (const [name, job] of credentialed) {
			assert.ok(!BYPASS.test(String(job.if ?? '')), `${name} has a condition that bypasses a failed approval: ${job.if}`);
		}
	});
});
