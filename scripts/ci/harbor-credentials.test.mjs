// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for the model credentials in the Harbor agent check (.github/workflows/harbor-agent-check.yml).
// The benchmark job runs agent sessions and install scripts from the PR under evaluation while it
// holds Bedrock credentials, and the agent can read them. These checks keep what those credentials
// can do, and for how long, bounded by the workflow:
//   - the workflow is only dispatched by hand, never by a pull_request or pull_request_target event,
//     and it resolves the PR revisions only on main;
//   - the benchmark job's token can only read contents and request an OIDC token;
//   - the Bedrock session lives HARBOR_SESSION_SECONDS (900 to 3600), and run.py receives the
//     deadline so it stops Harbor when the credentials expire;
//   - the inline session policy is valid JSON and allows only model invocation of the pinned model.
//
// Run: node --test scripts/ci/harbor-credentials.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/harbor-agent-check.yml', import.meta.url));
const PINS = fileURLToPath(new URL('../harbor-bench/pins.py', import.meta.url));
const workflow = parse(readFileSync(WORKFLOW, 'utf8'));
const model = /^MODEL = '([^']+)'$/m.exec(readFileSync(PINS, 'utf8'))?.[1];

const benchmark = workflow.jobs.benchmark;
const steps = benchmark.steps;
const assume = steps.find((s) => s.name === 'Assume dedicated Bedrock-only role');
const deadline = steps.find((s) => s.id === 'deadline');
const run = steps.find((s) => s.id === 'run');

const MIN_SECONDS = 900;
const MAX_SECONDS = 3600;

describe('Harbor model credentials', () => {
	it('runs only on a manual dispatch from main', () => {
		assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
		assert.match(workflow.jobs.revisions.if, /github\.ref == 'refs\/heads\/main'/);
		assert.deepEqual(workflow.permissions, { contents: 'read' });
	});

	it('gives the benchmark job token only contents read and OIDC', () => {
		assert.equal(benchmark.environment, 'harbor-bench');
		assert.deepEqual(benchmark.permissions, { contents: 'read', 'id-token': 'write' });
	});

	it('keeps the Bedrock session short and hands its deadline to run.py', () => {
		assert.ok(assume, 'expected the Bedrock role step');
		const seconds = Number(benchmark.env?.HARBOR_SESSION_SECONDS);
		assert.ok(
			Number.isInteger(seconds) && seconds >= MIN_SECONDS && seconds <= MAX_SECONDS,
			`HARBOR_SESSION_SECONDS must be an integer from ${MIN_SECONDS} to ${MAX_SECONDS}, got ${benchmark.env?.HARBOR_SESSION_SECONDS}`,
		);
		assert.equal(assume.with['role-duration-seconds'], '${{ env.HARBOR_SESSION_SECONDS }}');
		assert.ok(deadline, 'expected a step that records the credential deadline');
		const order = (step) => steps.indexOf(step);
		assert.ok(order(deadline) < order(assume), 'the deadline must be recorded before the role is assumed');
		assert.match(deadline.run, /HARBOR_SESSION_SECONDS/);
		assert.equal(run.env?.CREDENTIALS_EXPIRE_AT, '${{ steps.deadline.outputs.expire_at }}');
		assert.match(run.run, /--credentials-expire-at "\$CREDENTIALS_EXPIRE_AT"/);
	});

	it('limits the Bedrock session policy to invoking the pinned model', () => {
		assert.ok(model, 'expected MODEL in pins.py');
		const policy = JSON.parse(assume.with['inline-session-policy']);
		assert.equal(policy.Version, '2012-10-17');
		assert.ok(policy.Statement.length > 0);
		for (const statement of policy.Statement) {
			assert.equal(statement.Effect, 'Allow');
			assert.deepEqual(
				[statement.Action].flat().sort(),
				['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
			);
			for (const resource of [statement.Resource].flat()) {
				assert.ok(
					resource.endsWith(`/${model}`) || resource.endsWith(`/${model.replace(/^global\./, '')}`),
					`${resource} is not the pinned model`,
				);
			}
		}
	});
});
