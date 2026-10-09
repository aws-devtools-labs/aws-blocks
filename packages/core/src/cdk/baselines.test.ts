// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The stack-level orphaned-baseline check (task D4b). A Building Block that
 * guards a stateful resource writes a committed baseline with a
 * `removalGuard`; when the block is renamed or removed nothing reads that file,
 * so `BlocksStack` / `BlocksBackend` fail synth for any such file no block
 * claims — even when the app contains no block at all.
 *
 * `bb-auth`'s `baseline-orphans.cdk.test.ts` covers the same check end to end
 * with real `Auth` blocks.
 */

import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import type { ScopeParent } from '../common/index.js';
import { baselineDir, claimBaseline, hasOrphanedBaselines } from './baselines.js';
import { BlocksBackend } from './blocks-backend.js';
import { Compute } from './compute/compute.js';
import type { DefaultComputeFactory } from './compute/default-compute-factory.js';
import { BlocksPresets, BlocksStack } from './index.js';

/** A default compute with an inline Lambda (no bundling), enough for create() and synth. */
class StubCompute extends Compute {
	readonly fn: lambda.Function;
	readonly apiUrl = 'https://example.invalid/aws-blocks/api';

	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope });
		this.fn = new lambda.Function(this, 'Handler', {
			runtime: lambda.Runtime.NODEJS_22_X,
			handler: 'index.handler',
			code: lambda.Code.fromInline('exports.handler = async () => {};'),
			role: this.executionRole,
		});
	}

	setEnv(key: string, value: string): void {
		this.fn.addEnvironment(key, value);
	}
	protected applyTracing(): void {}
	protected healthWidgets(): IWidget[][] {
		return [];
	}
	protected loggingWidgets(): IWidget[][] {
		return [];
	}
	protected tracingWidgets(): IWidget[][] {
		return [];
	}
}

const stubFactory: DefaultComputeFactory = (root) => new StubCompute(root as never, 'DefaultCompute');

const tempDirs: string[] = [];
let backendPath: string;
const savedEnv = process.env.BLOCKS_TEST_REBASELINE;

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
	const dir = mkdtempSync(join(tmpdir(), 'core-baselines-backend-'));
	tempDirs.push(dir);
	backendPath = join(dir, 'backend.mjs');
	writeFileSync(backendPath, 'export default () => {};\n');
});

after(() => {
	for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
	if (savedEnv === undefined) delete process.env.BLOCKS_TEST_REBASELINE;
	else process.env.BLOCKS_TEST_REBASELINE = savedEnv;
});

/** A fresh app directory; the backend handler is `<app>/aws-blocks/index.handler.ts`. */
function appHandlerPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'core-baselines-app-'));
	tempDirs.push(dir);
	return join(dir, 'aws-blocks', 'index.handler.ts');
}

const GUARD = {
	deletes: "the widget store 'S-thing' and every widget in it",
	rebaselineEnv: 'BLOCKS_TEST_REBASELINE',
	runbook: '"Renaming a thing" in the test DESIGN.md',
};

function writeBaseline(
	handlerPath: string,
	stack: string,
	fullId: string,
	body: Record<string, unknown> = { removalGuard: GUARD },
): string {
	const dir = baselineDir(handlerPath, stack);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${fullId}.thing.json`);
	writeFileSync(file, JSON.stringify({ stack, fullId, ...body }));
	return file;
}

async function stack(handlerPath: string, id = 'S'): Promise<{ app: cdk.App; stack: BlocksStack }> {
	const app = new cdk.App();
	const s = await BlocksStack.create(app, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath: backendPath,
		defaults: BlocksPresets.production,
		defaultComputeFactory: stubFactory,
	});
	return { app, stack: s };
}

function synthError(app: cdk.App): string | undefined {
	try {
		app.synth();
		return undefined;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

describe('orphaned baselines fail synth (BlocksStack)', () => {
	test('a guarded baseline no block claims fails, naming the fullId, what is deleted and every remedy', async () => {
		const handler = appHandlerPath();
		writeBaseline(handler, 'S', 'S-thing');
		const { app } = await stack(handler);
		const error = synthError(app);
		assert.ok(error, 'synth must fail');
		assert.match(error, /no block with fullId 'S-thing' exists in this app any more/);
		assert.match(error, /CloudFormation will delete the widget store 'S-thing' and every widget in it/);
		assert.match(error, /Restore the old id, so its fullId is 'S-thing' again/);
		assert.match(error, /"Renaming a thing" in the test DESIGN\.md/);
		assert.match(error, /removalPolicy: 'retain'/);
		assert.match(error, /BLOCKS_TEST_REBASELINE=S-thing <your synth\/deploy command>/);
	});

	test('it runs with no block in the app at all, and reports each orphan', async () => {
		const handler = appHandlerPath();
		writeBaseline(handler, 'S', 'S-one');
		writeBaseline(handler, 'S', 'S-two');
		const { app } = await stack(handler);
		const error = synthError(app) ?? '';
		assert.match(error, /'S-one'/);
		assert.match(error, /'S-two'/);
	});

	test('a claimed baseline passes', async () => {
		const handler = appHandlerPath();
		const file = writeBaseline(handler, 'S', 'S-thing');
		const { app, stack: s } = await stack(handler);
		claimBaseline(new Construct(s, 'thing'), file);
		assert.strictEqual(synthError(app), undefined);
	});

	test('only the claimed one passes when one of two blocks is gone', async () => {
		const handler = appHandlerPath();
		const kept = writeBaseline(handler, 'S', 'S-kept');
		writeBaseline(handler, 'S', 'S-gone');
		const { app, stack: s } = await stack(handler);
		claimBaseline(new Construct(s, 'kept'), kept);
		const error = synthError(app) ?? '';
		assert.match(error, /'S-gone'/);
		assert.doesNotMatch(error, /'S-kept'/);
	});

	test('a baseline without `removalGuard` (the block owned nothing stateful) is ignored', async () => {
		const handler = appHandlerPath();
		writeBaseline(handler, 'S', 'S-thing', { ownsPool: false });
		const { app } = await stack(handler);
		assert.strictEqual(synthError(app), undefined);
	});

	test("another stack's baseline is ignored", async () => {
		const handler = appHandlerPath();
		writeBaseline(handler, 'OtherStack', 'OtherStack-thing');
		const { app } = await stack(handler);
		assert.strictEqual(synthError(app), undefined);
	});

	test('an unreadable unclaimed baseline fails closed', async () => {
		const handler = appHandlerPath();
		const dir = baselineDir(handler, 'S');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'S-thing.thing.json'), '<<<<<<< HEAD\n{');
		const { app } = await stack(handler);
		assert.match(synthError(app) ?? '', /cannot be read/);
	});

	test('no baselines directory: nothing to check', async () => {
		const { app } = await stack(appHandlerPath());
		assert.strictEqual(synthError(app), undefined);
	});
});

describe('the escape hatch names the fullId', () => {
	test('<rebaselineEnv>=<fullId> deletes the orphaned baseline and passes', async () => {
		const handler = appHandlerPath();
		const file = writeBaseline(handler, 'S', 'S-thing');
		process.env.BLOCKS_TEST_REBASELINE = 'S-other, S-thing';
		try {
			const { app } = await stack(handler);
			assert.strictEqual(synthError(app), undefined);
			assert.strictEqual(existsSync(file), false, 'the stale baseline is deleted');
		} finally {
			delete process.env.BLOCKS_TEST_REBASELINE;
		}
	});

	for (const value of ['1', 'true', '*', 'S-thingX', 'S']) {
		test(`<rebaselineEnv>=${value} does not`, async () => {
			const handler = appHandlerPath();
			const file = writeBaseline(handler, 'S', 'S-thing');
			process.env.BLOCKS_TEST_REBASELINE = value;
			try {
				const { app } = await stack(handler);
				assert.match(synthError(app) ?? '', /'S-thing'/);
				assert.ok(existsSync(file), 'the baseline is kept');
			} finally {
				delete process.env.BLOCKS_TEST_REBASELINE;
			}
		});
	}

	test('a removalGuard naming a variable outside BLOCKS_* is never honoured', async () => {
		const handler = appHandlerPath();
		const file = writeBaseline(handler, 'S', 'S-thing', { removalGuard: { ...GUARD, rebaselineEnv: 'HOME' } });
		const { app } = await stack(handler);
		assert.ok(synthError(app));
		assert.ok(existsSync(file));
	});
});

describe('BlocksBackend', () => {
	test('checks baselines/<backend fullId>/, and claims resolve to the backend', async () => {
		const handler = appHandlerPath();
		const app = new cdk.App();
		const host = new cdk.Stack(app, 'Host');
		// The backend's BLOCKS_STACK_NAME is `${stackName}-${id}`.
		const claimed = writeBaseline(handler, 'Host-Blocks', 'Host-Blocks-kept');
		writeBaseline(handler, 'Host-Blocks', 'Host-Blocks-gone');
		writeBaseline(handler, 'Host', 'Host-unrelated');
		const backend = await BlocksBackend.create(host, 'Blocks', {
			backendHandlerPath: handler,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: stubFactory,
		});
		claimBaseline(new Construct(backend, 'kept'), claimed);
		const error = synthError(app) ?? '';
		assert.match(error, /Blocks stack 'Host-Blocks': no block with fullId 'Host-Blocks-gone'/);
		assert.doesNotMatch(error, /Host-Blocks-kept|Host-unrelated/);
	});
});

describe('hasOrphanedBaselines', () => {
	test('is true while an orphan fails synth, false once it is claimed or re-baselined', async () => {
		const handler = appHandlerPath();
		const file = writeBaseline(handler, 'S', 'S-thing');
		const seen: boolean[] = [];
		const probe = (s: Construct) =>
			new Construct(s, `probe${seen.length}`).node.addValidation({
				validate: () => {
					seen.push(hasOrphanedBaselines(s));
					return [];
				},
			});

		const orphaned = await stack(handler);
		probe(orphaned.stack);
		assert.ok(synthError(orphaned.app));

		const claimed = await stack(handler);
		claimBaseline(new Construct(claimed.stack, 'thing'), file);
		probe(claimed.stack);
		assert.strictEqual(synthError(claimed.app), undefined);

		process.env.BLOCKS_TEST_REBASELINE = 'S-thing';
		try {
			const rebaselined = await stack(handler);
			probe(rebaselined.stack);
			assert.strictEqual(synthError(rebaselined.app), undefined);
		} finally {
			delete process.env.BLOCKS_TEST_REBASELINE;
		}
		assert.deepStrictEqual(seen, [true, false, false]);
	});
});

describe('claimBaseline', () => {
	test('is a no-op outside a BlocksStack / BlocksBackend', () => {
		const app = new cdk.App();
		const plain = new cdk.Stack(app, 'Plain');
		claimBaseline(new Construct(plain, 'thing'), '/nowhere/x.json');
		assert.doesNotThrow(() => app.synth());
	});

	test('baselineDir is <dirname(backendHandlerPath)>/baselines/<stack>', () => {
		assert.strictEqual(
			baselineDir('/app/aws-blocks/index.handler.ts', 'Prod'),
			join('/app/aws-blocks', 'baselines', 'Prod'),
		);
	});
});
