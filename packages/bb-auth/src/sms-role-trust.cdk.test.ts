// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `Auth` pools that send SMS (phone sign-in, or SMS MFA) get an SMS role from
 * CDK's `UserPool`. These tests build them under a real `BlocksStack`, so the
 * stack's synth-time service-principal trust check runs on that role, and pin
 * its trust to Cognito user pools in this account and region (src/cdk/sms-role.ts).
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { synthBlocksApp } from './test-support/blocks-app-synth.js';
import type { CfnTemplateJson } from './test-support/cdk-synth.js';
import { freshAppDir } from './test-support/guard-synth.js';

const tempDirs: string[] = [];
after(() => {
	for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** Synth a BlocksStack holding one `Auth` built with `options` (JavaScript source); fails if synth fails. */
function synthPool(options: string): CfnTemplateJson {
	const appDir = freshAppDir();
	tempDirs.push(appDir);
	const result = synthBlocksApp({ build: `new Auth(stack, 'auth', ${options});`, appDir });
	assert.ok(result.ok && result.template, result.stderr);
	return result.template;
}

function resourcesOfType(
	template: CfnTemplateJson,
	type: string,
): [string, { Properties?: Record<string, unknown> }][] {
	return Object.entries(template.Resources ?? {}).filter(([, r]) => r.Type === type) as [
		string,
		{ Properties?: Record<string, unknown> },
	][];
}

/** The SMS role's single trust statement and the pool's SMS external id. */
function smsTrust(template: CfnTemplateJson): { statement: Record<string, unknown>; externalId: unknown } {
	const roles = resourcesOfType(template, 'AWS::IAM::Role').filter(([logicalId]) => logicalId.includes('smsRole'));
	assert.strictEqual(roles.length, 1, 'exactly one SMS role');
	const doc = roles[0][1].Properties?.AssumeRolePolicyDocument as { Statement: Record<string, unknown>[] };
	assert.strictEqual(doc.Statement.length, 1);
	const pools = resourcesOfType(template, 'AWS::Cognito::UserPool');
	assert.strictEqual(pools.length, 1);
	const sms = pools[0][1].Properties?.SmsConfiguration as { ExternalId: unknown };
	return { statement: doc.Statement[0], externalId: sms.ExternalId };
}

describe('Auth SMS role in a BlocksStack', () => {
	for (const [label, options] of [
		["users.signInWith: ['phone']", "{ users: { signInWith: ['phone'] } }"],
		['mfa: required with SMS', "{ mfa: { mode: 'required', types: ['SMS'] } }"],
	] as const) {
		test(`${label}: synthesizes, and the SMS role trust is scoped to this account's user pools`, () => {
			const { statement, externalId } = smsTrust(synthPool(options));
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

	test('a pool without SMS gets no SMS role', () => {
		const roles = resourcesOfType(synthPool('{}'), 'AWS::IAM::Role').filter(([id]) => id.includes('smsRole'));
		assert.deepStrictEqual(roles, []);
	});
});
