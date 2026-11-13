// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The hook as `npm run deploy` and `npm run sandbox` run it: core's runner
 * finds it through this package's `aws-blocks.predeploy` declaration in an app
 * that depends on the block, and calls it with a real synthesized assembly.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type DeployStage, type PredeployAccount, runPredeployHooks } from '@aws-blocks/core/scripts';
import * as cdk from 'aws-cdk-lib';
import { CfnDBCluster } from 'aws-cdk-lib/aws-rds';

/** This package's root: the directory of its package.json. */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CALLER = '111111111111';

describe('predeploy, through the pre-deploy hook runner', () => {
	let app: string;

	beforeEach(() => {
		app = mkdtempSync(join(tmpdir(), 'bb-data-predeploy-'));
		writeFileSync(
			join(app, 'package.json'),
			JSON.stringify({ name: 'app', dependencies: { '@aws-blocks/bb-data': '*' } }),
		);
		mkdirSync(join(app, 'node_modules', '@aws-blocks'), { recursive: true });
		symlinkSync(packageRoot, join(app, 'node_modules', '@aws-blocks', 'bb-data'), 'dir');
	});

	afterEach(() => {
		rmSync(app, { recursive: true, force: true });
	});

	/**
	 * Synthesize a parent stack with a nested stack whose own nested stack holds
	 * an Aurora cluster. `assetMetadata` mirrors the CDK CLI default
	 * (`aws:asset:path` on the nested stack resources); without it, core finds
	 * the template through the asset manifest.
	 */
	function synth({
		assetMetadata,
		conditional = false,
		account,
	}: {
		assetMetadata: boolean;
		conditional?: boolean;
		account?: string;
	}): string {
		// Path metadata is on as the CDK CLI sets it, so the messages name construct paths.
		const cdkApp = new cdk.App({
			outdir: join(app, 'cdk.out'),
			context: { 'aws:cdk:enable-path-metadata': true, 'aws:cdk:enable-asset-metadata': assetMetadata },
		});
		const parent = new cdk.Stack(cdkApp, 'Parent', account ? { env: { account, region: 'eu-north-1' } } : {});
		const child = new cdk.NestedStack(parent, 'Child');
		const grandchild = new cdk.NestedStack(child, 'Grandchild');
		new CfnDBCluster(grandchild, 'Db', { engine: 'aurora-postgresql' });
		if (conditional) {
			const resource = child.nestedStackResource;
			assert.ok(resource);
			resource.cfnOptions.condition = new cdk.CfnCondition(parent, 'CreateDb', {
				expression: cdk.Fn.conditionEquals(new cdk.CfnParameter(parent, 'Db').valueAsString, 'yes'),
			});
		}
		cdkApp.synth();
		return 'cdk.out';
	}

	async function run(
		assemblyDir: string,
		{
			stage = 'production',
			account = { id: CALLER, plan: 'FREE' },
		}: { stage?: DeployStage; account?: PredeployAccount } = {},
	) {
		const warnings: string[] = [];
		const result = await runPredeployHooks({
			stage,
			projectRoot: app,
			assemblyDir,
			invocation: stage === 'production' ? 'npm run deploy' : 'npm run sandbox',
			account,
			log: () => {},
			warn: (line) => warnings.push(line),
		});
		return { ...result, warnings };
	}

	for (const assetMetadata of [true, false]) {
		it(`stops on an Aurora cluster two nested stacks down (asset metadata ${assetMetadata ? 'on' : 'off'})`, async () => {
			await assert.rejects(run(synth({ assetMetadata })), (error: Error) => {
				assert.match(error.message, /^\[@aws-blocks\/bb-data\] `npm run deploy` stopped before deploying/);
				assert.match(error.message, /^ {4}Parent: Parent\/Child\/Grandchild\/Db$/m);
				return true;
			});
		});
	}

	it('runs in the sandbox stage too', async () => {
		await assert.rejects(run(synth({ assetMetadata: true }), { stage: 'sandbox' }), /`npm run sandbox` stopped/);
	});

	it('warns instead of stopping when an enclosing nested stack is conditional', async () => {
		const { ran, warnings } = await run(synth({ assetMetadata: true, conditional: true }));
		assert.deepEqual(ran, ['@aws-blocks/bb-data']);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? '', /^\[@aws-blocks\/bb-data\] ⚠️ {2}This AWS account is on the Free plan/);
		assert.match(warnings[0] ?? '', /decided at deploy time[\s\S]*Parent: Parent\/Child\/Grandchild\/Db/);
	});

	it('gives nested stacks the target account of their parent', async () => {
		const { warnings } = await run(synth({ assetMetadata: true, account: '222222222222' }));
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? '', /Parent \(account 222222222222\): Parent\/Child\/Grandchild\/Db/);
	});

	it('lets a Paid-plan deploy through', async () => {
		const { ran, warnings } = await run(synth({ assetMetadata: true }), { account: { id: CALLER, plan: 'PAID' } });
		assert.deepEqual(ran, ['@aws-blocks/bb-data']);
		assert.deepEqual(warnings, []);
	});
});
