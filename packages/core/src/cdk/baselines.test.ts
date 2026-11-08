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
import {
	BASELINE_FORMAT_VERSION,
	baselineDir,
	claimBaseline,
	hasOrphanedBaselines,
	readBaselineFormatVersion,
} from './baselines.js';
import { BlocksBackend } from './blocks-backend.js';
import { ComputeBase } from './compute/compute.js';
import type { DefaultComputeFactory } from './compute/default-compute-factory.js';
import { BlocksPresets, BlocksStack } from './index.js';

/** A default compute with an inline Lambda (no bundling), enough for create() and synth. */
class StubCompute extends ComputeBase {
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
	// The shared stack-level REST API (#734) fronts this function.
	override apiHandler(): lambda.IFunction {
		return this.fn;
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
	const dir = baselineDir({ backendHandlerPath: handlerPath, stack });
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
		claimBaseline({ scope: new Construct(s, 'thing'), file });
		assert.strictEqual(synthError(app), undefined);
	});

	test('only the claimed one passes when one of two blocks is gone', async () => {
		const handler = appHandlerPath();
		const kept = writeBaseline(handler, 'S', 'S-kept');
		writeBaseline(handler, 'S', 'S-gone');
		const { app, stack: s } = await stack(handler);
		claimBaseline({ scope: new Construct(s, 'kept'), file: kept });
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
		const dir = baselineDir({ backendHandlerPath: handler, stack: 'S' });
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'S-thing.thing.json'), '<<<<<<< HEAD\n{');
		const { app } = await stack(handler);
		assert.match(synthError(app) ?? '', /cannot be read/);
	});

	test('the format version is 1', () => {
		assert.strictEqual(BASELINE_FORMAT_VERSION, 1);
	});

	test('an unclaimed guarded baseline is checked the same with `version: 1` or with no version (written before the field)', async () => {
		for (const body of [{ version: 1, removalGuard: GUARD }, { removalGuard: GUARD }]) {
			const handler = appHandlerPath();
			writeBaseline(handler, 'S', 'S-thing', body);
			const { app } = await stack(handler);
			assert.match(synthError(app) ?? '', /no block with fullId 'S-thing' exists in this app any more/);
		}
	});

	test('an unclaimed baseline in a newer format version fails synth with an upgrade message, guard or not', async () => {
		for (const body of [{ version: 2, removalGuard: GUARD }, { version: 2 }]) {
			const handler = appHandlerPath();
			writeBaseline(handler, 'S', 'S-thing', body);
			const { app, stack: s } = await stack(handler);
			const seen: boolean[] = [];
			s.node.addValidation({
				validate: () => {
					seen.push(hasOrphanedBaselines(s));
					return [];
				},
			});
			const error = synthError(app) ?? '';
			assert.match(
				error,
				/uses format version 2, written by a newer version of @aws-blocks\/core or of the Building Block that owns it; this version reads versions 1 to 1/,
			);
			assert.match(error, /Upgrade @aws-blocks\/core/);
			assert.doesNotMatch(error, /not a valid baseline file/);
			assert.deepStrictEqual(seen, [true], 'a synth that fails on it reports hasOrphanedBaselines');
		}
	});

	test('a `version` that is not a positive integer (string, 0, negative, null, fractional, boolean) is an invalid file', async () => {
		for (const version of ['1', 0, -1, null, 1.5, true]) {
			const handler = appHandlerPath();
			const file = writeBaseline(handler, 'S', 'S-thing', { version, removalGuard: GUARD });
			const { app } = await stack(handler);
			const error = synthError(app) ?? '';
			assert.match(error, /is not a valid baseline file/, `version ${JSON.stringify(version)}`);
			assert.ok(
				error.includes(`\`version\` is ${JSON.stringify(version)}, but must be a whole number from 1`),
				`version ${JSON.stringify(version)}: ${error}`,
			);
			assert.match(error, /Restore it from version control/);
			assert.doesNotMatch(error, /newer version/);
			assert.ok(existsSync(file), 'an invalid file is never deleted');
		}
	});

	test('a newer or invalid baseline is not deleted by its re-baseline variable: it fails, the file stays', async () => {
		for (const [version, message] of [
			[2, /uses format version 2/],
			['two', /is not a valid baseline file/],
		] as const) {
			const handler = appHandlerPath();
			const file = writeBaseline(handler, 'S', 'S-thing', { version, removalGuard: GUARD });
			process.env.BLOCKS_TEST_REBASELINE = 'S-thing';
			try {
				const { app } = await stack(handler);
				assert.match(synthError(app) ?? '', message);
				assert.ok(existsSync(file), 'a file this version cannot read is never deleted');
			} finally {
				delete process.env.BLOCKS_TEST_REBASELINE;
			}
		}
	});

	test('readBaselineFormatVersion({ file }): absent → 1, 1..current supported, higher → newer, anything else → invalid', () => {
		assert.deepStrictEqual(readBaselineFormatVersion({ file: {} }), { status: 'supported', version: 1 });
		for (let v = 1; v <= BASELINE_FORMAT_VERSION; v++) {
			assert.deepStrictEqual(readBaselineFormatVersion({ file: { version: v } }), { status: 'supported', version: v });
		}
		assert.deepStrictEqual(readBaselineFormatVersion({ file: { version: BASELINE_FORMAT_VERSION + 1 } }), {
			status: 'newer',
			version: BASELINE_FORMAT_VERSION + 1,
		});
		for (const version of ['1', 0, -1, null, 1.5, true, Number.NaN, Number.POSITIVE_INFINITY, [1], { v: 1 }]) {
			assert.strictEqual(readBaselineFormatVersion({ file: { version } }).status, 'invalid', JSON.stringify(version));
		}
		// `newest` is a reader's own ceiling (an options field, not positional).
		assert.deepStrictEqual(readBaselineFormatVersion({ file: { version: 2 }, newest: 1 }), { status: 'newer', version: 2 });
		assert.deepStrictEqual(readBaselineFormatVersion({ file: { version: 2 }, newest: 2 }), { status: 'supported', version: 2 });
	});

	test('a JSON file without a string `fullId` is not a baseline, whatever its `version`', async () => {
		const handler = appHandlerPath();
		const dir = baselineDir({ backendHandlerPath: handler, stack: 'S' });
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'notes.json'), JSON.stringify({ version: 2, removalGuard: GUARD }));
		writeFileSync(join(dir, 'numeric.json'), JSON.stringify({ version: 2, fullId: 7 }));
		const { app } = await stack(handler);
		assert.strictEqual(synthError(app), undefined);
	});

	test('upgrade: an unclaimed baseline committed in bb-auth’s format (with or without `version`) is still an orphan', async () => {
		// The shape `@aws-blocks/bb-auth` writes (and earlier builds wrote) — core
		// reads only `version`, `fullId` and `removalGuard`; the rest is the block's.
		const committed = {
			$comment: 'Generated by @aws-blocks/bb-auth at synth. Commit this file.',
			version: 1,
			stack: 'S',
			fullId: 'S-auth',
			ownsPool: true,
			pool: { version: 1, usernameAttributes: [], aliasAttributes: ['email'] },
			removalGuard: {
				deletes: "the Cognito user pool 'S-auth' and every user in it",
				rebaselineEnv: 'BLOCKS_AUTH_REBASELINE',
				runbook: '"Renaming or removing an Auth block" in the @aws-blocks/bb-auth DESIGN.md',
			},
		};
		const { version: _v, ...withoutVersion } = committed;
		for (const body of [committed, withoutVersion]) {
			const handler = appHandlerPath();
			const dir = baselineDir({ backendHandlerPath: handler, stack: 'S' });
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, 'S-auth.auth-pool.json'), `${JSON.stringify(body, null, '\t')}\n`);
			const { app } = await stack(handler);
			const error = synthError(app) ?? '';
			assert.match(error, /no block with fullId 'S-auth' exists in this app any more/);
			assert.match(error, /CloudFormation will delete the Cognito user pool 'S-auth'/);
		}
	});

	test('a claimed baseline in an unknown format version is left to the block that claims it', async () => {
		const handler = appHandlerPath();
		const file = writeBaseline(handler, 'S', 'S-thing', { version: 2, removalGuard: GUARD });
		const { app, stack: s } = await stack(handler);
		claimBaseline({ scope: new Construct(s, 'thing'), file });
		assert.strictEqual(synthError(app), undefined);
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
		claimBaseline({ scope: new Construct(backend, 'kept'), file: claimed });
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
		claimBaseline({ scope: new Construct(claimed.stack, 'thing'), file });
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
		claimBaseline({ scope: new Construct(plain, 'thing'), file: '/nowhere/x.json' });
		assert.doesNotThrow(() => app.synth());
	});

	test('baselineDir is <dirname(backendHandlerPath)>/baselines/<stack>', () => {
		assert.strictEqual(
			baselineDir({ backendHandlerPath: '/app/aws-blocks/index.handler.ts', stack: 'Prod' }),
			join('/app/aws-blocks', 'baselines', 'Prod'),
		);
	});
});
