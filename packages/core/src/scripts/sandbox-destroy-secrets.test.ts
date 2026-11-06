// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// `sandbox destroy` deletes the database connection string that the sandbox
// deploy wrote to SSM outside CloudFormation, and only the sandbox's own name.

import assert from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { deleteSandboxSecrets } from './ensure-secrets.js';
import { runSandboxDestroy, type SandboxDestroySteps } from './sandbox.js';

function awsError(name: string): Error {
	const error = new Error(`${name}: detail`);
	error.name = name;
	return error;
}

describe('sandbox destroy deletes the sandbox SSM secrets', () => {
	let root: string;
	let savedCwd: string;

	beforeEach(async () => {
		savedCwd = process.cwd();
		root = await mkdtemp(join(tmpdir(), 'blocks-destroy-secrets-'));
		mkdirSync(join(root, '.blocks'));
		writeFileSync(join(root, '.blocks', 'config.json'), JSON.stringify({ stackId: 'zz-app' }));
		mkdirSync(join(root, '.blocks-sandbox'));
		writeFileSync(join(root, '.blocks-sandbox', 'sandbox-id.txt'), 'dev-abc123\n');
		// Keep the destroy's progress off stdout: in a `node --test` child, stdout carries the runner's
		// serialized messages, and these lines sometimes broke them ("Unable to deserialize cloned data").
		mock.method(console, 'log', () => {});
		mock.method(console, 'error', () => {});
	});

	afterEach(async () => {
		mock.restoreAll();
		process.chdir(savedCwd);
		await rm(root, { recursive: true, force: true });
	});

	it("deletes the sandbox's connection-string parameter, never the production one", async () => {
		const names: string[] = [];
		const deleted = await deleteSandboxSecrets(root, async (name) => {
			names.push(name);
		});
		assert.deepStrictEqual(names, ['/zz-app-dev-abc123-db-url']);
		assert.deepStrictEqual(deleted, ['/zz-app-dev-abc123-db-url']);
	});

	it('skips an app whose .blocks/config.json gives no stack name, without calling SSM', async () => {
		await rm(join(root, '.blocks'), { recursive: true, force: true });
		const names: string[] = [];
		const deleted = await deleteSandboxSecrets(root, async (name) => {
			names.push(name);
		});
		assert.deepStrictEqual(deleted, []);
		assert.deepStrictEqual(names, []);
	});

	it('skips a parameter that does not exist (an app without an external database)', async () => {
		const deleted = await deleteSandboxSecrets(root, async () => {
			throw awsError('ParameterNotFound');
		});
		assert.deepStrictEqual(deleted, []);
	});

	it('warns with the parameter name and the delete command when SSM refuses, and does not fail', async () => {
		const warn = mock.method(console, 'warn', () => {});
		const deleted = await deleteSandboxSecrets(root, async () => {
			throw awsError('AccessDeniedException');
		});
		assert.deepStrictEqual(deleted, []);
		assert.strictEqual(warn.mock.callCount(), 1);
		const message = String(warn.mock.calls[0].arguments[0]);
		assert.match(message, /SSM parameter \/zz-app-dev-abc123-db-url,.* could not be deleted \(AccessDeniedException\)/);
		assert.match(message, /aws ssm delete-parameter --name \/zz-app-dev-abc123-db-url/);
	});

	function steps(calls: string[], destroy: () => Promise<void>): SandboxDestroySteps {
		return {
			checkCredentials: async () => {
				calls.push('check');
			},
			retryClients: async () => {
				calls.push('clients');
				return { cfnFor: () => ({}) as never, s3: {} as never };
			},
			destroy: async () => {
				calls.push('destroy');
				await destroy();
			},
			deleteSecrets: async (projectRoot) => {
				calls.push(`secrets:${projectRoot}`);
				return [];
			},
		};
	}

	it('runs the delete after the stack is destroyed, in the project root', async () => {
		process.chdir(root);
		const calls: string[] = [];
		await runSandboxDestroy('aws-blocks/index.cdk.ts', steps(calls, async () => {}));
		assert.deepStrictEqual(calls, ['check', 'clients', 'destroy', `secrets:${process.cwd()}`]);
	});

	it('keeps the parameter when the stack destroy fails, so the sandbox still works', async () => {
		process.chdir(root);
		const calls: string[] = [];
		await assert.rejects(
			runSandboxDestroy(
				'aws-blocks/index.cdk.ts',
				steps(calls, async () => {
					throw new Error('destroy failed');
				}),
			),
			/destroy failed/,
		);
		assert.deepStrictEqual(calls, ['check', 'clients', 'destroy']);
	});
});
