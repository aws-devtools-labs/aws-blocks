// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Exercises the real production wiring: `@aws-blocks/blocks`'s `BlocksStack` /
 * `BlocksBackend` wrappers inject `LambdaCompute` as the default-compute factory
 * into core's `create()`. Core's own tests use an inline stub compute and
 * `bb-lambda-compute`'s tests inject a factory by hand, so nothing else covers
 * the umbrella path — a dropped factory argument or a wrong construct id here
 * would otherwise ship uncaught.
 *
 * Must run under `--conditions=cdk` so the BB packages resolve their CDK entries
 * (real infra) rather than the default mock stubs.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BlocksStack, BlocksBackend, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute';

const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let backendPath: string;
let tmpDir: string;

before(() => {
	// This file is run with `--conditions=cdk` (see package.json test script) so
	// the BB imports above resolve their CDK entries. The handler entry (for the
	// NodejsFunction) and a no-op backend module (imported by create()) go in a
	// temp dir under the package — the handler entry must live under the project
	// root, which CDK's NodejsFunction requires.
	tmpDir = mkdtempSync(join(__dirname, 'tmp-umbrella-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
	backendPath = join(tmpDir, 'backend.mjs');
	writeFileSync(backendPath, 'export default () => {};\n');
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('umbrella injects the Lambda default compute', () => {
	test('BlocksStack.create() resolves the default to a LambdaCompute with one function + gateway', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'UmbrellaStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
		});

		// The umbrella wrapper injected LambdaCompute (not a stub); the stack's
		// handler/gateway delegate to it. (The `fn`/`apiGateway` members live on
		// the CDK-typed LambdaCompute; TS resolves the import to the mock type
		// here, so we assert through the stack's typed getters instead.)
		assert.ok(stack._defaultCompute instanceof LambdaCompute, 'default compute should be a LambdaCompute');
		assert.ok(stack.handler, 'stack.handler resolves through the default compute');
		assert.ok(stack.gateway, 'stack.gateway resolves through the default compute');
		assert.ok(stack.apiUrl, 'stack.apiUrl resolves through the default compute');

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
		template.hasResourceProperties('AWS::Lambda::Function', {});
	});

	test('BlocksBackend.create() resolves the default to a LambdaCompute', async () => {
		const app = new cdk.App();
		const parent = new cdk.Stack(app, 'UmbrellaBackendParent');
		const backend = await BlocksBackend.create(parent, 'Blocks', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
		});

		assert.ok(backend._defaultCompute instanceof LambdaCompute, 'default compute should be a LambdaCompute');
		assert.ok(backend.handler, 'backend.handler resolves through the default compute');
		assert.ok(backend.apiUrl, 'backend.apiUrl resolves through the default compute');

		const template = Template.fromStack(parent);
		template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
	});
});
