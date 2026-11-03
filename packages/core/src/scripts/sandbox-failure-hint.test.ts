// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// A failed sandbox deploy suggests destroying the sandbox only when a stack is
// actually left in a failed state (or its state is unknown).

import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { type SandboxFailureInput, sandboxFailureHint, sandboxFailureKind } from './sandbox.js';

/** CloudFormation clients that answer DescribeStacks from `byStack` (an Error is thrown). */
function cfnFor(byStack: Record<string, string | Error>): SandboxFailureInput['cfnFor'] {
	return async () => () =>
		({
			send: async (command: { input: { StackName: string } }) => {
				const result = byStack[command.input.StackName];
				if (result instanceof Error) throw result;
				return { Stacks: [{ StackStatus: result }] };
			},
		}) as unknown as CloudFormationClient;
}

const noAws: SandboxFailureInput['cfnFor'] = async () => {
	throw new Error('must not call AWS');
};

const STACK = [{ stackName: 'zz-app-dev-1' }];

describe('sandboxFailureKind', () => {
	it('a failed synth touched no stack', async () => {
		const kind = await sandboxFailureKind({
			phase: 'synth',
			lines: ['Error [ERR_MODULE_NOT_FOUND]: Cannot find module /work/sp'],
			stacks: [],
			cfnFor: noAws,
		});
		assert.strictEqual(kind, 'synth');
	});

	it("CDK's lock error means another sandbox command is running", async () => {
		const kind = await sandboxFailureKind({
			phase: 'synth',
			lines: [
				"Another CLI (PID=4179307) is currently synthing to .blocks-sandbox/cdk.out. Invoke the CLI in sequence, or use '--output' to synth into different directories.",
			],
			stacks: [],
			cfnFor: noAws,
		});
		assert.strictEqual(kind, 'locked');
	});

	it('a stack that is still updating is in progress, from the output or from its status', async () => {
		assert.strictEqual(
			await sandboxFailureKind({
				phase: 'deploy',
				lines: ['ValidationError: Stack:arn:aws:cloudformation:… is in UPDATE_IN_PROGRESS state and can not be updated.'],
				stacks: STACK,
				cfnFor: noAws,
			}),
			'in-progress',
		);
		assert.strictEqual(
			await sandboxFailureKind({
				phase: 'deploy',
				lines: [],
				stacks: STACK,
				cfnFor: cfnFor({ 'zz-app-dev-1': 'UPDATE_IN_PROGRESS' }),
			}),
			'in-progress',
		);
	});

	for (const status of ['CREATE_FAILED', 'UPDATE_FAILED', 'ROLLBACK_COMPLETE', 'UPDATE_ROLLBACK_FAILED']) {
		it(`a stack in ${status} is a failed stack`, async () => {
			const kind = await sandboxFailureKind({ phase: 'deploy', lines: [], stacks: STACK, cfnFor: cfnFor({ 'zz-app-dev-1': status }) });
			assert.strictEqual(kind, 'failed-stack');
		});
	}

	it('an updatable or missing stack is healthy', async () => {
		const kind = await sandboxFailureKind({
			phase: 'deploy',
			lines: [],
			stacks: [{ stackName: 'a' }, { stackName: 'b' }],
			cfnFor: cfnFor({ a: 'UPDATE_ROLLBACK_COMPLETE', b: new Error('Stack with id b does not exist') }),
		});
		assert.strictEqual(kind, 'healthy');
	});

	it('a status it cannot read, or no stack list, is unknown', async () => {
		assert.strictEqual(
			await sandboxFailureKind({ phase: 'deploy', lines: [], stacks: STACK, cfnFor: cfnFor({ 'zz-app-dev-1': new Error('AccessDenied') }) }),
			'unknown',
		);
		assert.strictEqual(await sandboxFailureKind({ phase: 'deploy', lines: [], stacks: STACK, cfnFor: noAws }), 'unknown');
		assert.strictEqual(await sandboxFailureKind({ phase: 'deploy', lines: [], stacks: [], cfnFor: noAws }), 'unknown');
	});
});

describe('sandboxFailureHint', () => {
	it('recommends a destroy only for a failed stack or an unknown state', () => {
		for (const kind of ['failed-stack', 'unknown'] as const) {
			assert.match(sandboxFailureHint(kind), /npm run sandbox:destroy\s+# tears the failed stack down/);
		}
		for (const kind of ['synth', 'locked', 'in-progress', 'healthy'] as const) {
			assert.doesNotMatch(sandboxFailureHint(kind), /tears the failed stack down|redeploy from a clean slate/, kind);
		}
	});

	it('says what to do for each other cause', () => {
		assert.match(sandboxFailureHint('synth'), /failed to synthesize, so no AWS resource was changed/);
		assert.match(sandboxFailureHint('locked'), /run one sandbox command at a time/);
		const inProgress = sandboxFailureHint('in-progress', ['zz-app-dev-1']);
		assert.match(inProgress, /still updating zz-app-dev-1, for example after an interrupted deploy/);
		assert.match(inProgress, /describe-stacks --stack-name zz-app-dev-1/);
		assert.match(inProgress, /don't destroy the sandbox/);
		assert.match(sandboxFailureHint('healthy'), /nothing to destroy/);
	});

	it('names the commands the user runs', () => {
		const kinds = ['failed-stack', 'unknown', 'synth', 'locked', 'in-progress', 'healthy'] as const;
		for (const kind of kinds) {
			const hint = sandboxFailureHint(kind, [], 'cdk-blocks sandbox deploy', 'cdk-blocks sandbox destroy');
			assert.match(hint, /`?cdk-blocks sandbox (deploy|destroy)`?/, kind);
			assert.doesNotMatch(hint, /npm run/, kind);
		}
		assert.match(
			sandboxFailureHint('locked', [], 'cdk-blocks sandbox deploy', 'cdk-blocks sandbox destroy'),
			/another `cdk-blocks sandbox deploy` or\n\s+`cdk-blocks sandbox destroy`/,
		);
	});
});
