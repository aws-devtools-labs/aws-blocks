// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
	generateBoundaryPolicy,
	generateExecutionPolicy,
	MANAGED_POLICY_MAX_CHARS,
	type PolicyDocument,
	policySize,
} from './iam-policies.js';

/** IAM's `*` / `?` wildcard match. */
const glob = (pattern: string, value: string) =>
	new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(value);

type Statement = {
	Effect: string;
	Action: string | string[];
	Resource?: string | string[];
	NotResource?: string | string[];
	Condition?: Record<string, Record<string, string>>;
};
const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * Does the boundary's Deny apply to `action` on `arn`, for a role tagged
 * `app=<principalApp>` and a resource tagged `app=<resourceApp>`? Evaluates the
 * statement shapes the generator emits: Action, Resource/NotResource, and the
 * StringNotEquals-on-resource-tag and Null-on-principal-tag conditions.
 */
function denied(doc: PolicyDocument, action: string, arn: string, principalApp: string | undefined, resourceApp?: string) {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the IAM policy variable the boundary uses
	const sub = (s: string) => s.replaceAll('${aws:PrincipalTag/app}', principalApp ?? '\u0000');
	return (doc.Statement as Statement[]).some((s) => {
		if (s.Effect !== 'Deny') return false;
		if (!list(s.Action).some((a) => glob(a, action))) return false;
		if (s.Resource && !list(s.Resource).some((r) => glob(sub(r), arn))) return false;
		if (s.NotResource && list(s.NotResource).some((r) => glob(sub(r), arn))) return false;
		const c = s.Condition;
		if (c?.StringNotEquals?.['aws:ResourceTag/app'] && resourceApp === principalApp) return false;
		if (c?.Null?.['aws:PrincipalTag/app'] === 'true' && principalApp !== undefined) return false;
		return true;
	});
}

describe('blocks-iam-policies — the shared boundary', () => {
	const boundary = generateBoundaryPolicy();

	test('fits in one managed policy', () => {
		assert.ok(policySize(boundary) <= MANAGED_POLICY_MAX_CHARS, `${policySize(boundary)} characters`);
	});

	const own: [string, string, string?][] = [
		['ssm:GetParameter', 'arn:aws:ssm:us-east-1:111111111111:parameter/appa-app-auth-session-secret'],
		['ssm:GetParameterHistory', 'arn:aws:ssm:us-east-1:111111111111:parameter/appa/api-key'],
		['dynamodb:GetItem', 'arn:aws:dynamodb:us-east-1:111111111111:table/appa-app-notes'],
		['dynamodb:Query', 'arn:aws:dynamodb:us-east-1:111111111111:table/appa-app-notes/index/byDate'],
		['sqs:SendMessage', 'arn:aws:sqs:us-east-1:111111111111:appa-app-reports'],
		['s3:GetObject', 'arn:aws:s3:::appa-app-files/a.txt'],
		['s3:GetObject', 'arn:aws:s3:::cdk-appa-assets-111111111111-us-east-1/asset.zip'],
		['secretsmanager:GetSecretValue', 'arn:aws:secretsmanager:us-east-1:111111111111:secret:db-AbCdEf', 'appa'],
		['lambda:InvokeFunction', 'arn:aws:lambda:us-east-1:111111111111:function:appa-Handler', 'appa'],
		['logs:PutLogEvents', 'arn:aws:logs:us-east-1:111111111111:log-group:/aws/lambda/appa-Handler:*'],
	];
	for (const [action, arn, tag] of own) {
		test(`allows the app its own: ${action} ${arn.split(':').slice(5).join(':')}`, () => {
			assert.strictEqual(denied(boundary, action, arn, 'appa', tag), false);
		});
	}

	const other: [string, string, string?][] = [
		['ssm:GetParameter', 'arn:aws:ssm:us-east-1:111111111111:parameter/appb-db-password'],
		['ssm:GetParameterHistory', 'arn:aws:ssm:us-east-1:111111111111:parameter/appb-db-password'],
		['ssm:PutParameter', 'arn:aws:ssm:us-east-1:111111111111:parameter/appab-key'],
		['dynamodb:Scan', 'arn:aws:dynamodb:us-east-1:111111111111:table/appb-app-notes'],
		['sqs:ReceiveMessage', 'arn:aws:sqs:us-east-1:111111111111:appb-app-reports'],
		['s3:GetObject', 'arn:aws:s3:::appb-app-files/a.txt'],
		['s3:PutObject', 'arn:aws:s3:::cdk-appb-assets-111111111111-us-east-1/asset.zip'],
		['secretsmanager:GetSecretValue', 'arn:aws:secretsmanager:us-east-1:111111111111:secret:db-AbCdEf', 'appb'],
		['lambda:InvokeFunction', 'arn:aws:lambda:us-east-1:111111111111:function:appb-Handler', 'appb'],
		['iam:AttachRolePolicy', 'arn:aws:iam::111111111111:role/appa-Role'],
	];
	for (const [action, arn, tag] of other) {
		test(`denies another app's: ${action} ${arn.split(':').slice(5).join(':')}`, () => {
			assert.strictEqual(denied(boundary, action, arn, 'appa', tag), true);
		});
	}

	test("denies an untagged role every app's data", () => {
		assert.strictEqual(
			denied(boundary, 'ssm:GetParameter', 'arn:aws:ssm:us-east-1:111111111111:parameter/appa-x', undefined),
			true,
		);
	});
});

describe('blocks-iam-policies — the per-app execution policy', () => {
	const types = [
		'AWS::IAM::Role',
		'AWS::IAM::Policy',
		'AWS::Lambda::Function',
		'AWS::Logs::LogGroup',
		'AWS::DynamoDB::Table',
		'AWS::ApiGateway::RestApi',
		'AWS::ApiGateway::Deployment',
		'AWS::Custom::Thing',
		'AWS::Bedrock::KnowledgeBase',
		'Custom::S3AutoDeleteObjects',
	];
	const { document, unscoped } = generateExecutionPolicy(types, { appId: 'appa', account: '111111111111' });
	const statements = document.Statement as (Statement & { Sid: string })[];
	const sid = (s: string) => statements.find((x) => x.Sid === s);

	test('creates only bounded roles, named and tagged as the app', () => {
		const create = sid('RolesOnlyWithTheBoundary');
		assert.deepStrictEqual(create?.Resource, 'arn:aws:iam::111111111111:role/appa-*');
		assert.deepStrictEqual(create?.Condition, {
			StringEquals: { 'iam:PermissionsBoundary': 'arn:aws:iam::111111111111:policy/apps-boundary' },
		});
		assert.deepStrictEqual(sid('RequireThisAppsTag')?.Condition, { StringNotEquals: { 'aws:RequestTag/app': 'appa' } });
	});

	test("re-tagging denies only a request that sets app to another value (other tag updates still work)", () => {
		assert.deepStrictEqual(sid('NoRetaggingToAnotherApp')?.Condition, {
			StringNotEquals: { 'aws:RequestTag/app': 'appa' },
			'ForAnyValue:StringEquals': { 'aws:TagKeys': ['app'] },
		});
	});

	test('denies attaching broad AWS managed policies', () => {
		assert.ok(sid('NoBroadManagedPolicies'));
	});

	test("scopes each resource type the app uses to the app's names or tag", () => {
		assert.deepStrictEqual(sid('Tables')?.Resource, [
			'arn:aws:dynamodb:*:111111111111:table/appa-*',
			'arn:aws:dynamodb:*:111111111111:table/appa-*/*',
		]);
		assert.deepStrictEqual(sid('ApisManage')?.Condition, { StringEquals: { 'aws:ResourceTag/app': 'appa' } });
		assert.strictEqual(sid('Queues'), undefined, 'no SQS rule for an app with no queue');
	});

	test('lists the resource types it has no scoped rule for', () => {
		assert.deepStrictEqual(unscoped, ['AWS::Bedrock::KnowledgeBase', 'AWS::Custom::Thing']);
	});

	test('needs the app id and a 12-digit account', () => {
		assert.throws(() => generateExecutionPolicy(types, { account: '111111111111' }), /app id/);
		assert.throws(() => generateExecutionPolicy(types, { appId: 'appa', account: '1' }), /account/);
	});
});
