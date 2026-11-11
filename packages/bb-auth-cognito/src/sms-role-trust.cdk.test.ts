// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `AuthCognito` pools that send SMS (phone sign-in, or SMS MFA) get an SMS role
 * from CDK's `UserPool`. These tests build them under a real `BlocksStack`, so
 * the stack's synth-time service-principal trust check runs on that role (the
 * plain-`Stack` tests in index.cdk.test.ts never register it).
 */

import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ScopeParent } from '@aws-blocks/core';
import { BlocksPresets, BlocksStack } from '@aws-blocks/core/cdk';
import { ComputeBase, type DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { AuthCognito } from './index.cdk.js';
import type { AuthCognitoOptions } from './types.js';

/** A minimal default compute: an inline Lambda on the shared role (core's tests use the same shape). */
class StubCompute extends ComputeBase {
	readonly fn: lambda.Function;

	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope });
		this.fn = new lambda.Function(this, 'Handler', {
			runtime: lambda.Runtime.NODEJS_22_X,
			handler: 'index.handler',
			code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200, body: "{}" });'),
			role: this.executionRole,
		});
	}

	setEnv(key: string, value: string): void {
		this.fn.addEnvironment(key, value);
	}

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

const stubComputeFactory: DefaultComputeFactory = (root) => new StubCompute(root as never, 'DefaultCompute');

const __dirname = dirname(fileURLToPath(import.meta.url));
let tmpDir: string;
let handlerPath: string;
let backendPath: string;

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
	tmpDir = mkdtempSync(join(__dirname, 'tmp-sms-role-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
	backendPath = join(tmpDir, 'backend.mjs');
	writeFileSync(backendPath, 'export default () => {};\n');
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Synth a BlocksStack holding one AuthCognito with `options`; throws if the trust check fails. */
async function synthPool(id: string, options: AuthCognitoOptions): Promise<Template> {
	const app = new cdk.App();
	const stack = await BlocksStack.create(app, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath: backendPath,
		defaults: BlocksPresets.production,
		defaultComputeFactory: stubComputeFactory,
	});
	new AuthCognito(stack as unknown as ScopeParent, 'auth', options);
	app.synth();
	return Template.fromStack(stack);
}

/** The SMS role's single trust statement and the pool's SMS external id. */
function smsTrust(template: Template): { statement: Record<string, unknown>; externalId: unknown } {
	const roles = Object.entries(template.findResources('AWS::IAM::Role')).filter(([logicalId]) =>
		logicalId.includes('smsRole'),
	);
	assert.strictEqual(roles.length, 1, 'exactly one SMS role');
	const statements = roles[0][1].Properties.AssumeRolePolicyDocument.Statement as Record<string, unknown>[];
	assert.strictEqual(statements.length, 1);
	const pools = Object.values(template.findResources('AWS::Cognito::UserPool'));
	assert.strictEqual(pools.length, 1);
	return { statement: statements[0], externalId: pools[0].Properties.SmsConfiguration.ExternalId };
}

describe('AuthCognito SMS role in a BlocksStack', () => {
	for (const [label, options] of [
		["signInWith: 'phone'", { signInWith: 'phone' }],
		["mfa: 'required' with SMS", { mfa: 'required', mfaTypes: ['SMS'] }],
	] as const) {
		test(`${label}: synthesizes, and the SMS role trust is scoped to this account's user pools`, async () => {
			const template = await synthPool(`SmsRole${label.replace(/[^A-Za-z]/g, '')}`, options);
			const { statement, externalId } = smsTrust(template);
			assert.strictEqual(typeof externalId, 'string');
			assert.deepStrictEqual(statement, {
				Action: 'sts:AssumeRole',
				Effect: 'Allow',
				Principal: { Service: 'cognito-idp.amazonaws.com' },
				Condition: {
					// The external id SMS needs is kept, and matches the pool's.
					StringEquals: { 'sts:ExternalId': externalId, 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
					ArnLike: {
						'aws:SourceArn': {
							'Fn::Join': [
								'',
								[
									'arn:',
									{ Ref: 'AWS::Partition' },
									':cognito-idp:',
									{ Ref: 'AWS::Region' },
									':',
									{ Ref: 'AWS::AccountId' },
									':userpool/*',
								],
							],
						},
					},
				},
			});
		});
	}

	test('a pool without SMS gets no SMS role', async () => {
		const template = await synthPool('NoSmsRole', { mfa: 'off' });
		const roles = Object.keys(template.findResources('AWS::IAM::Role')).filter((id) => id.includes('smsRole'));
		assert.deepStrictEqual(roles, []);
	});
});
