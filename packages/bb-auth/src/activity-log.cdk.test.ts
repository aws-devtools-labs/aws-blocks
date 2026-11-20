// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `activityLog`: the user pool exports Cognito's own user-activity log
 * (`userAuthEvents`) to a log group the stack owns.
 *
 * Pinned here, against real synths under `--conditions=cdk`:
 * - the pool's audit-only threat protection, the log group and the delivery;
 * - unset, the pool has no `UserPoolAddOns` and no log resources are added
 *   (the zero-config template is pinned byte-for-byte by
 *   `property-snapshot.cdk.test.ts`);
 * - turning it on later is an in-place update: every existing logical id and
 *   physical name is kept, and `UserPoolAddOns` is the only pool property that
 *   changes;
 * - synth refuses it without `featurePlan: 'plus'` and on a wrapped pool; a
 *   `store: 'builtin'` block (no pool) refuses it at construction.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { activityLogGroupName } from './cdk/activity-log.js';
import type { CfnResourceJson } from './test-support/cdk-synth.js';
import { diffIdentity, type SynthesizedAuth, synthIdentity } from './test-support/identity.js';

function only(synth: SynthesizedAuth, type: string): CfnResourceJson {
	const found = Object.values(synth.template.Resources).filter((r) => r.Type === type);
	assert.strictEqual(found.length, 1, `exactly one ${type}`);
	return found[0];
}

function count(synth: SynthesizedAuth, type: string): number {
	return Object.values(synth.template.Resources).filter((r) => r.Type === type).length;
}

/** The block's activity-log group, found by construct path (the pool guard has log groups of its own). */
function activityGroups(synth: SynthesizedAuth): CfnResourceJson[] {
	return Object.values(synth.template.Resources).filter(
		(r) =>
			r.Type === 'AWS::Logs::LogGroup' &&
			String(r.Metadata?.['aws:cdk:path']).startsWith('TestStack/auth/activity-log/'),
	);
}

function activityGroup(synth: SynthesizedAuth): CfnResourceJson {
	const groups = activityGroups(synth);
	assert.strictEqual(groups.length, 1, 'exactly one activity-log group');
	return groups[0];
}

function logicalIdOf(synth: SynthesizedAuth, resource: CfnResourceJson): string {
	const entry = Object.entries(synth.template.Resources).find(([, r]) => r === resource);
	assert.ok(entry, 'resource is in the template');
	return entry[0];
}

const ON = "new Auth(stack, 'auth', { featurePlan: 'plus', activityLog: true })";

describe('activityLog: Cognito exports user activity to an owned log group', () => {
	const synth = synthIdentity(ON, 'sandbox');

	test('threat protection in audit-only mode, so sign-ins are scored but never blocked', () => {
		const pool = only(synth, 'AWS::Cognito::UserPool');
		assert.deepStrictEqual(pool.Properties?.UserPoolAddOns, { AdvancedSecurityMode: 'AUDIT' });
		assert.strictEqual(pool.Properties?.UserPoolTier, 'PLUS');
	});

	test('a log group under /aws/vendedlogs/, kept for the stack log retention', () => {
		const group = activityGroup(synth);
		assert.strictEqual(group.Properties?.LogGroupName, '/aws/vendedlogs/cognito/TestStack-auth/user-activity');
		assert.strictEqual(group.Properties?.RetentionInDays, 7);
		assert.strictEqual(group.DeletionPolicy, 'Delete', 'a sandbox removes it with the pool');
	});

	test('the delivery sends INFO userAuthEvents from this pool to that group', () => {
		const pool = only(synth, 'AWS::Cognito::UserPool');
		const group = activityGroup(synth);
		const delivery = only(synth, 'AWS::Cognito::LogDeliveryConfiguration');
		assert.deepStrictEqual(delivery.Properties, {
			UserPoolId: { Ref: logicalIdOf(synth, pool) },
			LogConfigurations: [
				{
					EventSource: 'userAuthEvents',
					LogLevel: 'INFO',
					CloudWatchLogsConfiguration: { LogGroupArn: { 'Fn::GetAtt': [logicalIdOf(synth, group), 'Arn'] } },
				},
			],
		});
	});

	test('under the production preset the group is retained and kept a year, like the pool', () => {
		const prod = synthIdentity(ON, 'production');
		const group = activityGroup(prod);
		assert.strictEqual(group.Properties?.RetentionInDays, 365);
		assert.strictEqual(group.DeletionPolicy, 'Retain');
		assert.strictEqual(only(prod, 'AWS::Cognito::UserPool').DeletionPolicy, 'Retain');
	});

	test("removalPolicy: 'destroy' removes the group with the pool, whatever the preset", () => {
		const group = activityGroup(
			synthIdentity(
				"new Auth(stack, 'auth', { featurePlan: 'plus', activityLog: true, removalPolicy: 'destroy' })",
				'production',
			),
		);
		assert.strictEqual(group.DeletionPolicy, 'Delete');
	});

	test('unset: no UserPoolAddOns and no log resources', () => {
		const off = synthIdentity("new Auth(stack, 'auth', { featurePlan: 'plus' })", 'sandbox');
		assert.strictEqual(only(off, 'AWS::Cognito::UserPool').Properties?.UserPoolAddOns, undefined);
		assert.strictEqual(activityGroups(off).length, 0);
		assert.strictEqual(count(off, 'AWS::Cognito::LogDeliveryConfiguration'), 0);
	});

	test('a character a log-group name cannot hold becomes -', () => {
		assert.strictEqual(
			activityLogGroupName('My Stack-auth@1'),
			'/aws/vendedlogs/cognito/My-Stack-auth-1/user-activity',
		);
	});
});

describe('activityLog: turning it on for a deployed pool is an in-place update', () => {
	const before = synthIdentity("new Auth(stack, 'auth', { featurePlan: 'plus' })", 'sandbox');
	const after = synthIdentity(ON, 'sandbox');

	test('every existing resource keeps its logical id and physical name; only the log resources are added', () => {
		const lines = diffIdentity(before.identity, after.identity);
		assert.ok(
			lines.every((l) => l.startsWith('+ ADDED') && /activity-log/.test(l)),
			lines.join('\n'),
		);
	});

	test('UserPoolAddOns is the only pool property that changes', () => {
		const a = { ...(only(before, 'AWS::Cognito::UserPool').Properties ?? {}) };
		const b = { ...(only(after, 'AWS::Cognito::UserPool').Properties ?? {}) };
		delete b.UserPoolAddOns;
		assert.deepStrictEqual(b, a);
	});

	test('no IAM change: Cognito delivers through its own service-linked role, not the backend role', () => {
		const policies = (s: SynthesizedAuth) =>
			JSON.stringify(Object.values(s.template.Resources).filter((r) => r.Type.startsWith('AWS::IAM::')));
		assert.strictEqual(policies(after), policies(before));
	});
});

describe('activityLog: refused at synth where Cognito would export nothing', () => {
	test("without featurePlan: 'plus' (the default 'essentials')", () => {
		assert.throws(
			() => synthIdentity("new Auth(stack, 'auth', { activityLog: true })"),
			/`activityLog` needs `featurePlan: 'plus'` \(got the default 'essentials'\)/,
		);
	});

	test("with featurePlan: 'lite'", () => {
		assert.throws(
			() => synthIdentity("new Auth(stack, 'auth', { featurePlan: 'lite', activityLog: true })"),
			/`activityLog` needs `featurePlan: 'plus'` \(got 'lite'\)/,
		);
	});

	test('on a wrapped pool (Auth.fromExisting)', () => {
		assert.throws(
			() =>
				synthIdentity(
					"new Auth(stack, 'auth', { featurePlan: 'plus', activityLog: true, userPool: Auth.fromExisting('us-east-1_abc') })",
				),
			/`userPool` wraps an existing pool \(`Auth\.fromExisting`\), whose settings belong to its owner/,
		);
	});

	test("on a store: 'builtin' block (no user pool), in every layer, before synth", () => {
		assert.throws(
			() =>
				synthIdentity(
					"new Auth(stack, 'auth', { store: 'builtin', providers: { okta: { type: 'oidc', issuer: 'https://okta.example.com', clientId: 'c' } }, activityLog: true })",
				),
			/`activityLog` needs `store: 'cognito'` \(the default\)/,
		);
	});

	test('activityLog: false is accepted and adds nothing', () => {
		const synth = synthIdentity("new Auth(stack, 'auth', { activityLog: false })", 'sandbox');
		assert.strictEqual(only(synth, 'AWS::Cognito::UserPool').Properties?.UserPoolAddOns, undefined);
		assert.strictEqual(activityGroups(synth).length, 0);
	});
});
