// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
	generateBoundaryPolicy,
	generateDeployGuardPolicy,
	generateExecutionPolicy,
	MANAGED_POLICY_MAX_CHARS,
	type PolicyDocument,
	policySize,
	splitPolicy,
} from './iam-policies.js';

/** IAM's `*` / `?` wildcard match. */
const glob = (pattern: string, value: string, flags = '') =>
	new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, flags).test(value);

type Statement = {
	Effect: string;
	Action: string | string[];
	Resource?: string | string[];
	NotResource?: string | string[];
	Condition?: Record<string, Record<string, string | string[]>>;
};
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** The request: an action on a resource, by a role tagged `app=<principalApp>`. */
type Request = {
	action: string;
	arn: string;
	principalApp: string;
	resourceApp?: string;
	/** The `app` value the request itself sets as a tag (a create or tag call), if any. */
	requestApp?: string;
	/** The tag keys the request adds or removes (`aws:TagKeys`); defaults to `['app']` when it sets `requestApp`. */
	tagKeys?: string[];
	viaService?: string;
	roleArn?: string;
};

/**
 * Whether a statement applies to the request, for the shapes the generator emits:
 * Action, Resource / NotResource, StringEquals on `aws:ResourceTag/app`,
 * StringLike on `kms:ViaService`, StringNotLike on `cloudformation:RoleArn`.
 */
function matches(s: Statement, r: Request): boolean {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the IAM policy variable the boundary uses
	const sub = (v: string) => v.replaceAll('${aws:PrincipalTag/app}', r.principalApp);
	if (!list(s.Action).some((a) => glob(a, r.action, 'i'))) return false;
	if (s.Resource && !list(s.Resource).some((p) => glob(sub(p), r.arn))) return false;
	if (s.NotResource && list(s.NotResource).some((p) => glob(sub(p), r.arn))) return false;
	const c = s.Condition;
	// Deny "resource tagged as another app": StringNotEquals + Null=false on aws:ResourceTag/app.
	const notTag = c?.StringNotEquals?.['aws:ResourceTag/app'];
	if (notTag !== undefined && c?.Null?.['aws:ResourceTag/app'] === 'false') {
		if (r.resourceApp === undefined || r.resourceApp === notTag) return false;
	}
	const tagKeysCondition = (c as Record<string, Record<string, unknown>> | undefined)?.['ForAnyValue:StringEquals']?.['aws:TagKeys'];
	if (tagKeysCondition !== undefined) {
		const keys = r.tagKeys ?? (r.requestApp !== undefined ? ['app'] : []);
		if (!list(tagKeysCondition as string[]).some((k) => keys.includes(k))) return false;
	}
	const reqTag = c?.StringEquals?.['aws:RequestTag/app'];
	if (reqTag !== undefined && r.requestApp !== reqTag) return false;
	const notReqTag = c?.StringNotEquals?.['aws:RequestTag/app'];
	if (notReqTag !== undefined && (r.requestApp === undefined || r.requestApp === notReqTag)) return false;
	const tag = c?.StringEquals?.['aws:ResourceTag/app'];
	if (tag !== undefined && sub(tag as string) !== r.resourceApp) return false;
	const via = c?.StringLike?.['kms:ViaService'];
	if (via !== undefined && !(r.viaService && list(via).some((p) => glob(p, r.viaService as string)))) return false;
	const role = c?.StringNotLike?.['cloudformation:RoleArn'];
	if (role !== undefined && r.roleArn !== undefined && glob(role as string, r.roleArn)) return false;
	return true;
}
const allowed = (doc: PolicyDocument, r: Request) =>
	(doc.Statement as Statement[]).some((s) => s.Effect === 'Allow' && matches(s, r)) &&
	!(doc.Statement as Statement[]).some((s) => s.Effect === 'Deny' && matches(s, r));

const A = 'arn:aws';
const acct = '111111111111';

describe('blocks-iam-policies — the shared boundary (allow-list)', () => {
	const boundary = generateBoundaryPolicy();

	test('fits in one managed policy, and never allows every action', () => {
		assert.ok(policySize(boundary) <= MANAGED_POLICY_MAX_CHARS, `${policySize(boundary)} characters`);
		assert.ok(!(boundary.Statement as Statement[]).some((s) => s.Action === '*'));
	});

	const own: Omit<Request, 'principalApp'>[] = [
		{ action: 'ssm:GetParameter', arn: `${A}:ssm:us-east-1:${acct}:parameter/appa-app-auth-session-secret` },
		{ action: 'ssm:PutParameter', arn: `${A}:ssm:us-east-1:${acct}:parameter/appa/api-key` },
		{ action: 'ssm:GetParametersByPath', arn: `${A}:ssm:us-east-1:${acct}:parameter/appa` },
		{ action: 'ssm:PutParameter', arn: `${A}:ssm:us-east-1:${acct}:parameter/cdk/exports/appa/x` },
		{ action: 'dynamodb:Query', arn: `${A}:dynamodb:us-east-1:${acct}:table/appa-app-notes/index/byDate` },
		{ action: 'sqs:SendMessage', arn: `${A}:sqs:us-east-1:${acct}:appa-app-reports` },
		{ action: 's3:GetObject', arn: `${A}:s3:::appa-app-files/a.txt` },
		{ action: 's3:GetObject', arn: `${A}:s3:::cdk-appa-assets-${acct}-us-east-1/asset.zip` },
		{ action: 'lambda:InvokeFunction', arn: `${A}:lambda:us-east-1:${acct}:function:appa-Handler` },
		{ action: 'logs:PutLogEvents', arn: `${A}:logs:us-east-1:${acct}:log-group:/aws/lambda/appa-Handler:log-stream:x` },
		{ action: 'secretsmanager:GetSecretValue', arn: `${A}:secretsmanager:us-east-1:${acct}:secret:db-AbCdEf`, resourceApp: 'appa' },
		{ action: 'states:StartExecution', arn: `${A}:states:us-east-1:${acct}:stateMachine:Flow-x`, resourceApp: 'appa' },
		{ action: 'kms:Decrypt', arn: `${A}:kms:us-east-1:${acct}:key/managed`, viaService: 'ssm.us-east-1.amazonaws.com' },
		{ action: 'xray:PutTraceSegments', arn: '*' },
	];
	for (const r of own) {
		test(`allows the app its own: ${r.action} ${r.arn.split(':').slice(5).join(':') || r.arn}`, () => {
			assert.strictEqual(allowed(boundary, { principalApp: 'appa', ...r }), true);
		});
	}

	const other: Omit<Request, 'principalApp'>[] = [
		{ action: 'ssm:GetParameter', arn: `${A}:ssm:us-east-1:${acct}:parameter/appb-db-password` },
		{ action: 'ssm:GetParameterHistory', arn: `${A}:ssm:us-east-1:${acct}:parameter/appb-db-password` },
		{ action: 'ssm:PutParameter', arn: `${A}:ssm:us-east-1:${acct}:parameter/appab-key` },
		{ action: 'ssm:PutParameter', arn: `${A}:ssm:us-east-1:${acct}:parameter/cdk/exports/appab-x/y` },
		{ action: 'dynamodb:Scan', arn: `${A}:dynamodb:us-east-1:${acct}:table/appb-app-notes` },
		{ action: 's3:GetObject', arn: `${A}:s3:::appb-app-files/a.txt` },
		{ action: 's3:GetObject', arn: `${A}:s3:::cdk-appb-assets-${acct}-us-east-1/bundle.zip` },
		{ action: 's3:PutObject', arn: `${A}:s3:::cdk-appa-assets-${acct}-us-east-1/asset.zip` },
		{ action: 'lambda:UpdateFunctionCode', arn: `${A}:lambda:us-east-1:${acct}:function:appb-Handler` },
		{ action: 'lambda:GetFunction', arn: `${A}:lambda:us-east-1:${acct}:function:appb-Handler` },
		{ action: 'logs:GetLogEvents', arn: `${A}:logs:us-east-1:${acct}:log-group:/aws/lambda/appb-Handler:log-stream:x` },
		{ action: 'states:StartExecution', arn: `${A}:states:us-east-1:${acct}:stateMachine:Flow-y`, resourceApp: 'appb' },
		{
			action: 'cognito-idp:AdminSetUserPassword',
			arn: `${A}:cognito-idp:us-east-1:${acct}:userpool/us-east-1_x`,
			resourceApp: 'appb',
		},
		{ action: 'secretsmanager:GetSecretValue', arn: `${A}:secretsmanager:us-east-1:${acct}:secret:db-AbCdEf`, resourceApp: 'appb' },
		{ action: 'kms:Decrypt', arn: `${A}:kms:us-east-1:${acct}:key/appb-key`, resourceApp: 'appb' },
		{ action: 'iam:AttachRolePolicy', arn: `${A}:iam::${acct}:role/appa-Role` },
		{ action: 'sts:AssumeRole', arn: `${A}:iam::${acct}:role/appb-Role` },
		{ action: 'rekognition:DetectLabels', arn: '*' },
	];
	for (const r of other) {
		test(`denies: ${r.action} ${r.arn.split(':').slice(5).join(':') || r.arn}`, () => {
			assert.strictEqual(allowed(boundary, { principalApp: 'appa', ...r }), false);
		});
	}
});

describe('blocks-iam-policies — execute-api (per-app boundary)', () => {
	const ws = (apiId: string) => `${A}:execute-api:us-east-1:${acct}:${apiId}/prod/POST/@connections/abc`;

	test('the shared boundary allows no execute-api call at all', () => {
		assert.strictEqual(allowed(generateBoundaryPolicy(), { action: 'execute-api:ManageConnections', arn: ws('aaa111'), principalApp: 'appa' }), false);
	});

	test("a per-app boundary allows the app's own APIs only", () => {
		const own = generateBoundaryPolicy({ executeApiIds: ['aaa111'] });
		assert.strictEqual(allowed(own, { action: 'execute-api:ManageConnections', arn: ws('aaa111'), principalApp: 'appa' }), true);
		assert.strictEqual(allowed(own, { action: 'execute-api:ManageConnections', arn: ws('bbb222'), principalApp: 'appa' }), false);
		assert.strictEqual(allowed(own, { action: 'execute-api:Invoke', arn: `${A}:execute-api:us-east-1:${acct}:bbb222/prod/GET/x`, principalApp: 'appa' }), false);
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
		'AWS::ApiGatewayV2::Api',
		'AWS::Custom::Thing',
		'AWS::Bedrock::KnowledgeBase',
		'Custom::S3AutoDeleteObjects',
	];
	const { document, unscoped } = generateExecutionPolicy(types, { appId: 'appa', account: acct });
	const statements = document.Statement as (Statement & { Sid: string })[];
	const sid = (s: string) => statements.find((x) => x.Sid === s);

	test('creates only bounded roles, named and tagged as the app', () => {
		const create = sid('RolesOnlyWithTheBoundary');
		assert.deepStrictEqual(create?.Resource, `${A}:iam::${acct}:role/appa-*`);
		assert.deepStrictEqual(create?.Condition, {
			StringEquals: { 'iam:PermissionsBoundary': `${A}:iam::${acct}:policy/apps-boundary` },
		});
		assert.deepStrictEqual(sid('RequireThisAppsTag')?.Condition, { StringNotEquals: { 'aws:RequestTag/app': 'appa' } });
	});

	test('re-tagging denies only a request that sets app to another value (other tag updates still work)', () => {
		assert.deepStrictEqual(sid('NoRetaggingToAnotherApp')?.Condition, {
			StringNotEquals: { 'aws:RequestTag/app': 'appa' },
			'ForAnyValue:StringEquals': { 'aws:TagKeys': ['app'] },
		});
	});

	test('denies attaching broad AWS managed policies', () => {
		assert.ok(sid('NoBroadManagedPolicies'));
	});

	test("scopes each resource type the app uses to the app's names or tag; REST and HTTP APIs share one rule", () => {
		assert.deepStrictEqual(sid('Tables')?.Resource, [
			`${A}:dynamodb:*:${acct}:table/appa-*`,
			`${A}:dynamodb:*:${acct}:table/appa-*/*`,
		]);
		assert.deepStrictEqual(sid('ApisManage')?.Condition, { StringEquals: { 'aws:ResourceTag/app': 'appa' } });
		assert.strictEqual(sid('Queues'), undefined, 'no SQS rule for an app with no queue');
	});

	test('tag-scoped services: creates only top-level resources, manages only own-tagged ones, never another app\'s', () => {
		const exec = generateExecutionPolicy(['AWS::ApiGateway::RestApi', 'AWS::StepFunctions::StateMachine', 'AWS::SecretsManager::Secret'], {
			appId: 'appa',
			account: acct,
		}).document;
		const r = (action: string, arn: string, resourceApp?: string, extra: Partial<Request> = {}) =>
			allowed(exec, { action, arn, principalApp: 'appa', resourceApp, ...extra });
		const api = (path: string) => `${A}:apigateway:us-east-1::${path}`;
		// Creating the app's own API, and its children on its own API.
		assert.strictEqual(r('apigateway:POST', api('/restapis'), undefined, { requestApp: 'appa' }), true, 'create a REST API');
		assert.strictEqual(r('apigateway:POST', api('/restapis'), undefined), false, 'create an untagged REST API');
		assert.strictEqual(r('apigateway:POST', api('/restapis/own123/stages'), 'appa'), true, "a stage on the app's own API");
		assert.strictEqual(r('apigateway:TagResource', api('/tags/x'), 'appa', { requestApp: 'appa' }), true, 'tag its own API');
		// The live-proof gap: a child on another app's API, even with a request tag of this app.
		assert.strictEqual(
			r('apigateway:POST', api('/restapis/other99/stages'), 'appb', { requestApp: 'appa' }),
			false,
			"a stage on another app's API",
		);
		assert.strictEqual(r('apigateway:PUT', api('/tags/other'), 'appb', { requestApp: 'appa' }), false, "re-tag another app's API");
		assert.strictEqual(r('apigateway:TagResource', api('/tags/untagged'), undefined, { requestApp: 'appa' }), false, 'claim an untagged API');
		assert.strictEqual(r('apigateway:TagResource', api('/tags/x'), 'appa', { requestApp: 'appb' }), false, 'hand its own API to another app');
		assert.strictEqual(r('states:StartExecution', `${A}:states:us-east-1:${acct}:stateMachine:Gsi-x`, 'appa'), true);
		assert.strictEqual(r('states:StartExecution', `${A}:states:us-east-1:${acct}:stateMachine:Gsi-y`, 'appb'), false);
		assert.strictEqual(r('secretsmanager:GetSecretValue', `${A}:secretsmanager:us-east-1:${acct}:secret:db-x`, 'appb'), false);
	});

	test('pinned to the app\'s own API ids (--api-id): another API is denied even if it claims the app\'s tag', () => {
		const pinned = generateExecutionPolicy(['AWS::ApiGateway::RestApi'], { appId: 'appa', account: acct, apiIds: ['own123'] }).document;
		const r = (action: string, path: string, resourceApp: string, requestApp?: string) =>
			allowed(pinned, { action, arn: `${A}:apigateway:us-east-1::${path}`, principalApp: 'appa', resourceApp, requestApp });
		assert.strictEqual(r('apigateway:POST', '/restapis/own123/stages', 'appa'), true, 'a stage on its own API');
		assert.strictEqual(r('apigateway:PATCH', '/restapis/own123/stages/prod', 'appa'), true, 'update its own stage');
		assert.strictEqual(r('apigateway:DELETE', '/restapis/own123/resources/r1', 'appa'), true, 'delete its own resource');
		for (const [action, path] of [
			['apigateway:POST', '/restapis/other99/stages'],
			['apigateway:POST', '/restapis/other99/resources/root'],
			['apigateway:PATCH', '/restapis/other99/stages/prod'],
			['apigateway:DELETE', '/restapis/other99'],
			['apigateway:PUT', '/tags/arn%3Aaws%3Aapigateway%3Aus-east-1%3A%3A%2Frestapis%2Fother99'],
		]) {
			assert.strictEqual(r(action, path, 'appa', 'appa'), false, `${action} ${path} on an API tagged as this app but not pinned`);
		}
	});

	test("manages only the app's own layers", () => {
		assert.deepStrictEqual(sid('Layers')?.Resource, [`${A}:lambda:*:${acct}:layer:appa-*`, `${A}:lambda:*:${acct}:layer:appa-*:*`]);
		assert.strictEqual(sid('LayersUnscopedNames'), undefined);
	});

	test('reads only its own bootstrap: the qualifier is the app id', () => {
		assert.deepStrictEqual(sid('ReadOwnBootstrapVersion')?.Resource, [`${A}:ssm:*:${acct}:parameter/cdk-bootstrap/appa/*`]);
	});

	test('lists the resource types it has no scoped rule for', () => {
		assert.deepStrictEqual(unscoped, ['AWS::Bedrock::KnowledgeBase', 'AWS::Custom::Thing']);
	});

	test('needs the app id and a 12-digit account', () => {
		assert.throws(() => generateExecutionPolicy(types, { account: acct }), /app id/);
		assert.throws(() => generateExecutionPolicy(types, { appId: 'appa', account: '1' }), /account/);
	});
});

describe('blocks-iam-policies — the deploy guard', () => {
	const guard = generateDeployGuardPolicy({ appId: 'appa', account: acct });
	const ownExec = `${A}:iam::${acct}:role/cdk-appa-cfn-exec-role-${acct}-us-east-1`;
	const otherExec = `${A}:iam::${acct}:role/cdk-appb-cfn-exec-role-${acct}-us-east-1`;
	const stack = (name: string) => `${A}:cloudformation:us-east-1:${acct}:stack/${name}/uuid`;
	const denied = (action: string, arn: string, roleArn?: string) =>
		(guard.Statement as Statement[]).some(
			(s) => s.Effect === 'Deny' && matches(s, { action, arn, principalApp: 'appa', roleArn }),
		);

	test("denies changing or deleting another app's stack", () => {
		for (const action of ['cloudformation:CreateChangeSet', 'cloudformation:ExecuteChangeSet', 'cloudformation:DeleteStack']) {
			assert.strictEqual(denied(action, stack('appb'), ownExec), true, action);
			assert.strictEqual(denied(action, stack('appab'), ownExec), true, `${action} on a prefix-overlapping app`);
		}
	});

	test("denies a change set on its own stack that uses another app's execution role", () => {
		assert.strictEqual(denied('cloudformation:CreateChangeSet', stack('appa'), otherExec), true);
	});

	test('denies creating, changing or deleting a stack without naming a role (CloudFormation would reuse the old one)', () => {
		for (const action of ['cloudformation:DeleteStack', 'cloudformation:CreateChangeSet', 'cloudformation:UpdateStack']) {
			assert.strictEqual(denied(action, stack('appa'), undefined), true, action);
		}
	});

	test('allows its own stacks with its own execution role', () => {
		assert.strictEqual(denied('cloudformation:CreateChangeSet', stack('appa'), ownExec), false);
		assert.strictEqual(denied('cloudformation:ExecuteChangeSet', stack('appa-api'), ownExec), false);
		assert.strictEqual(denied('cloudformation:CreateChangeSet', stack('appa-edge'), ownExec), false);
	});

	test('denies changing its own bootstrap stack (only the platform re-bootstraps)', () => {
		assert.strictEqual(denied('cloudformation:CreateChangeSet', stack('CDKToolkit-appa'), ownExec), true);
	});

	test('needs the app id and a 12-digit account', () => {
		assert.throws(() => generateDeployGuardPolicy({ account: acct }), /app id/);
	});
});

describe('blocks-iam-policies — splitting a large execution policy', () => {
	test('every part fits IAM\'s limit, and no statement is lost or reordered', () => {
		const types = ['AWS::Lambda::Function', 'AWS::Logs::LogGroup', 'AWS::DynamoDB::Table', 'AWS::SQS::Queue', 'AWS::S3::Bucket',
			'AWS::SSM::Parameter', 'AWS::SecretsManager::Secret', 'AWS::ApiGateway::RestApi', 'AWS::Scheduler::Schedule', 'AWS::Events::Rule',
			'AWS::Cognito::UserPool', 'AWS::KMS::Key', 'AWS::StepFunctions::StateMachine', 'AWS::ResourceGroups::Group', 'AWS::CloudWatch::Dashboard'];
		const { document } = generateExecutionPolicy(types, { appId: 'appa', account: acct });
		const parts = splitPolicy(document);
		assert.ok(parts.length > 1, `expected a split, got ${policySize(document)} characters in one`);
		for (const part of parts) assert.ok(policySize(part) <= MANAGED_POLICY_MAX_CHARS, `${policySize(part)} characters`);
		assert.deepStrictEqual(parts.flatMap((p) => p.Statement), document.Statement);
	});
});
