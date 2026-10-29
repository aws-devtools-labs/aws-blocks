// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { APP_ID_PATTERN, isValidAppId, RESERVED_APP_ID_PREFIXES, RESERVED_APP_IDS } from '../cdk/app-isolation-rules.js';
import {
	EXECUTION_POLICY_SPLIT_CHARS,
	generateBoundaryPolicy,
	generateDeployGuardPolicy,
	generateExecutionPolicy,
	MANAGED_POLICY_MAX_CHARS,
	UNSCOPED_REASONS,
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
	/** Any other condition keys the request carries (`iam:AWSServiceName`, `lambda:FunctionArn`, …). */
	context?: Record<string, string | string[]>;
};

/** The request's condition context, as IAM sees it. */
function contextOf(r: Request): Record<string, string[]> {
	const c: Record<string, string[]> = {};
	if (r.resourceApp !== undefined) c['aws:ResourceTag/app'] = [r.resourceApp];
	if (r.requestApp !== undefined) c['aws:RequestTag/app'] = [r.requestApp];
	const keys = r.tagKeys ?? (r.requestApp !== undefined ? ['app'] : undefined);
	if (keys !== undefined) c['aws:TagKeys'] = keys;
	if (r.viaService !== undefined) c['kms:ViaService'] = [r.viaService];
	if (r.roleArn !== undefined) c['cloudformation:RoleArn'] = [r.roleArn];
	for (const [k, v] of Object.entries(r.context ?? {})) c[k] = list(v);
	return c;
}

/**
 * Whether a statement applies to the request: Action, Resource / NotResource, and
 * the condition operators the generator emits (StringEquals / StringNotEquals /
 * StringEqualsIfExists, StringLike / StringNotLike, ArnLike, Null, ForAnyValue:StringEquals), with
 * IAM's semantics for a key the request doesn't carry. An operator it doesn't
 * know fails the test, rather than being silently ignored.
 */
function matches(s: Statement, r: Request): boolean {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the IAM policy variable the boundary uses
	const sub = (v: string) => v.replaceAll('${aws:PrincipalTag/app}', r.principalApp);
	if (!list(s.Action).some((a) => glob(a, r.action, 'i'))) return false;
	if (s.Resource && !list(s.Resource).some((p) => glob(sub(p), r.arn))) return false;
	if (s.NotResource && list(s.NotResource).some((p) => glob(sub(p), r.arn))) return false;
	const ctx = contextOf(r);
	for (const [op, keys] of Object.entries(s.Condition ?? {})) {
		for (const [key, raw] of Object.entries(keys)) {
			const want = list(raw).map((v) => sub(String(v)));
			const have = ctx[key];
			const eq = (a: string, b: string) => a === b;
			const any = (f: (p: string, v: string) => boolean) => (have ?? []).some((v) => want.some((p) => f(p, v)));
			let ok: boolean;
			switch (op) {
				case 'StringEquals':
				case 'ForAnyValue:StringEquals':
					ok = any(eq);
					break;
				case 'StringNotEquals':
					ok = have === undefined || !any(eq);
					break;
				case 'StringEqualsIfExists':
					ok = have === undefined || any(eq);
					break;
				case 'StringLike':
				case 'ArnLike':
					ok = any((p, v) => glob(p, v));
					break;
				case 'StringNotLike':
					ok = have === undefined || !any((p, v) => glob(p, v));
					break;
				case 'Null':
					ok = (want[0] === 'true') === (have === undefined);
					break;
				default:
					throw new Error(`the test evaluator doesn't know the condition operator ${op}`);
			}
			if (!ok) return false;
		}
	}
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
		// A Database's cluster log group (its log-retention provider creates it).
		{ action: 'logs:CreateLogGroup', arn: `${A}:logs:us-east-1:${acct}:log-group:/aws/rds/cluster/appa-db-x1/postgresql` },
		{ action: 'logs:PutRetentionPolicy', arn: `${A}:logs:us-east-1:${acct}:log-group:/aws/rds/cluster/appa-db-x1/postgresql:*` },
		// Hosting config() / secret() under `blocks/<id>/` (stackId = app id), untagged.
		{ action: 'ssm:GetParameter', arn: `${A}:ssm:us-east-1:${acct}:parameter/blocks/appa/config/FEATURE_FLAGS` },
		{ action: 'secretsmanager:GetSecretValue', arn: `${A}:secretsmanager:us-east-1:${acct}:secret:blocks/appa/secrets/DEMO-AbCdEf` },
		// AWS-owned models and system-defined inference profiles: metadata reads.
		{ action: 'bedrock:GetFoundationModel', arn: `${A}:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0` },
		{ action: 'bedrock:GetInferenceProfile', arn: `${A}:bedrock:us-east-1:${acct}:inference-profile/us.amazon.nova-pro-v1:0` },
		{ action: 'bedrock:ListInferenceProfiles', arn: '*' },
		// A workload access token: the shared default directory, and the app's own (tagged) identity.
		{
			action: 'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
			arn: `${A}:bedrock-agentcore:us-east-1:${acct}:workload-identity-directory/default`,
		},
		{
			action: 'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
			arn: `${A}:bedrock-agentcore:us-east-1:${acct}:workload-identity-directory/default/workload-identity/rt1`,
			resourceApp: 'appa',
		},
		// CDK's Lambda@Edge ARN parameter for the app's own stack.
		{ action: 'ssm:GetParameter', arn: `${A}:ssm:us-east-1:${acct}:parameter/cdk/EdgeFunctionArn/eu-west-1/appa/Hosting/Fn` },
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
		{ action: 'logs:CreateLogGroup', arn: `${A}:logs:us-east-1:${acct}:log-group:/aws/rds/cluster/appb-db-x1/postgresql` },
		{ action: 'ssm:GetParameter', arn: `${A}:ssm:us-east-1:${acct}:parameter/blocks/appb/config/FEATURE_FLAGS` },
		{ action: 'ssm:GetParameter', arn: `${A}:ssm:us-east-1:${acct}:parameter/blocks/config/FEATURE_FLAGS` },
		{ action: 'ssm:GetParameter', arn: `${A}:ssm:us-east-1:${acct}:parameter/blocks/appab/config/X` },
		{ action: 'secretsmanager:GetSecretValue', arn: `${A}:secretsmanager:us-east-1:${acct}:secret:blocks/appb/secrets/DEMO-AbCdEf` },
		{ action: 'secretsmanager:GetSecretValue', arn: `${A}:secretsmanager:us-east-1:${acct}:secret:blocks/secrets/DEMO-AbCdEf` },
		// Another app's application inference profile (a separate, taggable resource type).
		{
			action: 'bedrock:GetInferenceProfile',
			arn: `${A}:bedrock:us-east-1:${acct}:application-inference-profile/abc123`,
			resourceApp: 'appb',
		},
		{ action: 'bedrock:DeleteInferenceProfile', arn: `${A}:bedrock:us-east-1:${acct}:inference-profile/us.amazon.nova-pro-v1:0` },
		{ action: 'ssm:GetParameter', arn: `${A}:ssm:us-east-1:${acct}:parameter/cdk/EdgeFunctionArn/eu-west-1/appb/Hosting/Fn` },
		{
			action: 'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
			arn: `${A}:bedrock-agentcore:us-east-1:${acct}:workload-identity-directory/default/workload-identity/rt2`,
			resourceApp: 'appb',
		},
		{ action: 'bedrock-agentcore:DeleteWorkloadIdentity', arn: `${A}:bedrock-agentcore:us-east-1:${acct}:workload-identity-directory/default` },
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
		assert.deepStrictEqual(unscoped, ['AWS::Custom::Thing']);
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

	test('denies creating or changing a stack without naming a role (CloudFormation would reuse the old one)', () => {
		for (const action of ['cloudformation:CreateChangeSet', 'cloudformation:CreateStack', 'cloudformation:UpdateStack']) {
			assert.strictEqual(denied(action, stack('appa'), undefined), true, action);
		}
	});

	test("deleting its own stack may omit the role (CDK's cleanup of a failed first deploy); a named role must be its own", () => {
		assert.strictEqual(denied('cloudformation:DeleteStack', stack('appa'), undefined), false, 'own stack, no RoleARN');
		assert.strictEqual(denied('cloudformation:DeleteStack', stack('appa-edge'), undefined), false, 'own helper stack, no RoleARN');
		assert.strictEqual(denied('cloudformation:DeleteStack', stack('appa'), ownExec), false, 'own stack, own role');
		assert.strictEqual(denied('cloudformation:DeleteStack', stack('appa'), otherExec), true, "own stack, another app's role");
		assert.strictEqual(denied('cloudformation:DeleteStack', stack('appb'), undefined), true, "another app's stack, no RoleARN");
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

describe('blocks-iam-policies — rules for the types Hosting, Database, DistributedDatabase, KnowledgeBase use', () => {
	const types = [
		'AWS::CloudFront::Distribution',
		'AWS::CloudFront::KeyValueStore',
		'AWS::CloudFront::Function',
		'AWS::CloudFront::OriginAccessControl',
		'AWS::CloudFront::CachePolicy',
		'AWS::CloudFront::OriginRequestPolicy',
		'AWS::CloudFront::ResponseHeadersPolicy',
		'AWS::SNS::Topic',
		'AWS::CloudWatch::Alarm',
		'AWS::Lambda::Function',
		'AWS::Lambda::EventSourceMapping',
		'AWS::IAM::ManagedPolicy',
		'AWS::SecretsManager::Secret',
		'AWS::S3Vectors::VectorBucket',
		'AWS::S3Vectors::Index',
		'AWS::DSQL::Cluster',
		'AWS::EC2::VPC',
		'AWS::EC2::Subnet',
		'AWS::EC2::SecurityGroup',
		'AWS::EC2::RouteTable',
		'AWS::EC2::SubnetRouteTableAssociation',
		'AWS::RDS::DBCluster',
		'AWS::RDS::DBInstance',
		'AWS::RDS::DBSubnetGroup',
		'AWS::Bedrock::KnowledgeBase',
		'AWS::Bedrock::DataSource',
		'AWS::ApiGateway::RestApi',
		'AWS::BedrockAgentCore::Runtime',
		'Custom::CrossRegionExportReader',
	];
	const result = generateExecutionPolicy(types, { appId: 'appa', account: acct });
	const exec = result.document;
	const r = (action: string, arn: string, extra: Partial<Request> = {}) => allowed(exec, { action, arn, principalApp: 'appa', ...extra });
	const cf = (path: string) => `${A}:cloudfront::${acct}:${path}`;

	test('only AgentCore is left unscoped (with a reason); CloudFront config is an accepted exception', () => {
		assert.deepStrictEqual(result.unscoped, ['AWS::BedrockAgentCore::Runtime']);
		assert.ok(UNSCOPED_REASONS['AWS::BedrockAgentCore::Runtime']);
		assert.deepStrictEqual(result.accepted, [
			'AWS::CloudFront::CachePolicy',
			'AWS::CloudFront::OriginAccessControl',
			'AWS::CloudFront::OriginRequestPolicy',
			'AWS::CloudFront::ResponseHeadersPolicy',
		]);
		const statements = exec.Statement as { Sid: string; Action: string | string[] }[];
		assert.ok(statements.some((st) => st.Sid === 'CloudFrontUnscopableConfig'));
		assert.ok(!statements.some((st) => list(st.Action).some((a) => a.startsWith('bedrock-agentcore:'))), 'no AgentCore grant');
	});

	test('a type in a namespace another rule handles is still reported when no rule names it', () => {
		const { unscoped, document } = generateExecutionPolicy(
			['AWS::CloudWatch::Alarm', 'AWS::CloudWatch::Dashboard', 'AWS::CloudWatch::CompositeAlarm', 'AWS::Lambda::CodeSigningConfig', 'AWS::ApiGateway::Account'],
			{ appId: 'appa', account: acct },
		);
		assert.deepStrictEqual(unscoped, ['AWS::ApiGateway::Account', 'AWS::CloudWatch::CompositeAlarm', 'AWS::Lambda::CodeSigningConfig']);
		const sids = (document.Statement as { Sid: string }[]).map((st) => st.Sid);
		assert.ok(sids.includes('Alarms') && sids.includes('Dashboards'), sids.join(','));
	});

	test('CloudFront: distributions and KeyValueStores by tag, functions by name, never another app\'s', () => {
		assert.strictEqual(r('cloudfront:CreateDistribution', cf('distribution/*'), { requestApp: 'appa' }), true);
		assert.strictEqual(r('cloudfront:CreateDistribution', cf('distribution/*')), false, 'untagged');
		assert.strictEqual(r('cloudfront:UpdateDistribution', cf('distribution/E1'), { resourceApp: 'appa' }), true);
		assert.strictEqual(r('cloudfront:UpdateDistribution', cf('distribution/E2'), { resourceApp: 'appb' }), false);
		assert.strictEqual(r('cloudfront:CreateInvalidation', cf('distribution/E2'), { resourceApp: 'appb' }), false);
		assert.strictEqual(r('cloudfront:CreateKeyValueStore', cf('key-value-store/*'), { requestApp: 'appa' }), true);
		assert.strictEqual(r('cloudfront:DeleteKeyValueStore', cf('key-value-store/k1'), { resourceApp: 'appa' }), true);
		assert.strictEqual(r('cloudfront:DeleteKeyValueStore', cf('key-value-store/k2'), { resourceApp: 'appb' }), false);
		assert.strictEqual(r('cloudfront:TagResource', cf('key-value-store/k1'), { resourceApp: 'appa', requestApp: 'appb' }), false, 'hand it to another app');
		assert.strictEqual(r('cloudfront:CreateFunction', cf('function/appa-us-east-1-appaHostingRouter1A2B3C4D')), true);
		assert.strictEqual(r('cloudfront:UpdateFunction', cf('function/appb-us-east-1-x')), false);
		assert.strictEqual(r('cloudfront:UpdateFunction', cf('function/us-east-1appaHostingRouter1A2B3C4D')), false, 'CDK-style name');
		assert.strictEqual(r('cloudfront:CreateCachePolicy', cf('cache-policy/*')), true, 'accepted exception');
	});

	test("SNS topics and CloudWatch alarms by name", () => {
		assert.strictEqual(r('sns:GetTopicAttributes', `${A}:sns:us-east-1:${acct}:appa-AlarmTopic-x`), true);
		assert.strictEqual(r('sns:SetTopicAttributes', `${A}:sns:us-east-1:${acct}:appb-AlarmTopic-x`), false);
		assert.strictEqual(r('sns:Subscribe', `${A}:sns:us-east-1:${acct}:appab-AlarmTopic-x`), false);
		assert.strictEqual(r('cloudwatch:PutMetricAlarm', `${A}:cloudwatch:us-east-1:${acct}:alarm:appa-Cf5xx-x`), true);
		assert.strictEqual(r('cloudwatch:DeleteAlarms', `${A}:cloudwatch:us-east-1:${acct}:alarm:appb-Cf5xx-x`), false);
	});

	test('event source mappings: tagged as the app on create, re-tagged or untagged only as the app', () => {
		const esm = `${A}:lambda:us-east-1:${acct}:event-source-mapping:1111-2222`;
		assert.strictEqual(r('lambda:TagResource', esm, { requestApp: 'appa' }), true, 'tag on create');
		assert.strictEqual(r('lambda:TagResource', esm, { requestApp: 'appb' }), false);
		assert.strictEqual(r('lambda:ListTags', esm, { resourceApp: 'appa' }), true);
		assert.strictEqual(r('lambda:UntagResource', esm, { resourceApp: 'appb', tagKeys: ['x'] }), false);
		assert.strictEqual(r('lambda:TagResource', esm, { resourceApp: 'appa', requestApp: 'appb' }), false, 'hand it to another app');
	});

	test("managed policies named <id>-…, never the boundary; generated secrets' random password", () => {
		assert.strictEqual(r('iam:CreatePolicy', `${A}:iam::${acct}:policy/appa-BlocksRoleOverflowPolicy1-X`), true);
		assert.strictEqual(r('iam:CreatePolicyVersion', `${A}:iam::${acct}:policy/appb-BlocksRoleOverflowPolicy1-X`), false);
		assert.strictEqual(r('iam:CreatePolicyVersion', `${A}:iam::${acct}:policy/apps-boundary`), false);
		assert.strictEqual(r('secretsmanager:GetRandomPassword', '*'), true);
	});

	test('S3 Vectors by name; DSQL and knowledge bases by tag', () => {
		assert.strictEqual(r('s3vectors:CreateIndex', `${A}:s3vectors:us-east-1:${acct}:bucket/appa-vec-x/index/i`), true);
		assert.strictEqual(r('s3vectors:DeleteIndex', `${A}:s3vectors:us-east-1:${acct}:bucket/appb-vec-x/index/i`), false);
		assert.strictEqual(r('dsql:CreateCluster', `${A}:dsql:us-east-1:${acct}:cluster/*`, { requestApp: 'appa' }), true);
		assert.strictEqual(r('dsql:CreateCluster', `${A}:dsql:us-east-1:${acct}:cluster/*`), false, 'untagged');
		assert.strictEqual(r('dsql:DeleteCluster', `${A}:dsql:us-east-1:${acct}:cluster/c2`, { resourceApp: 'appb' }), false);
		assert.strictEqual(r('dsql:GetCluster', `${A}:dsql:us-east-1:${acct}:cluster/c1`, { resourceApp: 'appa' }), true);
		assert.strictEqual(r('bedrock:CreateKnowledgeBase', '*', { requestApp: 'appa' }), true);
		assert.strictEqual(r('bedrock:CreateDataSource', `${A}:bedrock:us-east-1:${acct}:knowledge-base/KB1`, { resourceApp: 'appa' }), true);
		assert.strictEqual(r('bedrock:DeleteDataSource', `${A}:bedrock:us-east-1:${acct}:knowledge-base/KB2`, { resourceApp: 'appb' }), false);
	});

	test("EC2: VPC resources tagged as the app; children only in the app's own VPC", () => {
		const ec2 = (path: string) => `${A}:ec2:us-east-1:${acct}:${path}`;
		assert.strictEqual(r('ec2:CreateVpc', ec2('vpc/*'), { requestApp: 'appa' }), true);
		assert.strictEqual(r('ec2:CreateVpc', ec2('vpc/*')), false, 'untagged');
		assert.strictEqual(r('ec2:CreateSubnet', ec2('subnet/*'), { requestApp: 'appa' }), true);
		assert.strictEqual(r('ec2:CreateSubnet', ec2('vpc/vpc-own'), { resourceApp: 'appa' }), true, 'in its own VPC');
		assert.strictEqual(r('ec2:CreateSubnet', ec2('vpc/vpc-other'), { resourceApp: 'appb' }), false, "in another app's VPC");
		assert.strictEqual(r('ec2:CreateSecurityGroup', ec2('vpc/vpc-untagged')), false, 'in an untagged VPC');
		assert.strictEqual(r('ec2:DeleteSecurityGroup', ec2('security-group/sg-2'), { resourceApp: 'appb' }), false);
		assert.strictEqual(r('ec2:AssociateRouteTable', ec2('route-table/rtb-1'), { resourceApp: 'appa' }), true);
		assert.strictEqual(r('ec2:CreateTags', ec2('vpc/vpc-own'), { resourceApp: 'appa', requestApp: 'appb' }), false, 'hand it to another app');
		assert.strictEqual(r('ec2:DescribeVpcs', '*'), true);
	});

	test("RDS by name, plus using RDS's default parameter and option groups", () => {
		const rds = (path: string) => `${A}:rds:us-east-1:${acct}:${path}`;
		assert.strictEqual(r('rds:CreateDBCluster', rds('cluster:appa-dbcluster-x')), true);
		assert.strictEqual(r('rds:CreateDBCluster', rds('cluster-pg:default.aurora-postgresql16')), true);
		assert.strictEqual(r('rds:CreateDBSubnetGroup', rds('subgrp:appa-subnets-x')), true);
		assert.strictEqual(r('rds:DeleteDBCluster', rds('cluster:appb-dbcluster-x')), false);
		assert.strictEqual(r('rds:ModifyDBClusterParameterGroup', rds('cluster-pg:default.aurora-postgresql16')), false, 'edit a default group');
		assert.strictEqual(r('rds:DeleteDBSubnetGroup', rds('subgrp:appb-subnets-x')), false);
	});

	test('API Gateway: a REST API resource policy on create (the collection), and on its own API only', () => {
		const api = (path: string) => `${A}:apigateway:us-east-1::${path}`;
		assert.strictEqual(r('apigateway:UpdateRestApiPolicy', api('/restapis')), true);
		assert.strictEqual(r('apigateway:UpdateRestApiPolicy', api('/restapis/own123'), { resourceApp: 'appa' }), true);
		assert.strictEqual(r('apigateway:UpdateRestApiPolicy', api('/restapis/other99'), { resourceApp: 'appb' }), false);
		assert.strictEqual(r('apigateway:UpdateRestApiPolicy', api('/restapis/untagged')), false);
	});

	test("cross-region references: the app's own stacks' exports only", () => {
		assert.strictEqual(r('ssm:GetParameters', `${A}:ssm:us-east-1:${acct}:parameter/cdk/exports/appa-CfMonitoring-c8df000e/x`), true);
		assert.strictEqual(r('ssm:GetParameters', `${A}:ssm:us-east-1:${acct}:parameter/cdk/exports/appb-CfMonitoring-c8df000e/x`), false);
		assert.strictEqual(r('ssm:PutParameter', `${A}:ssm:us-east-1:${acct}:parameter/cdk/exports/appa-CfMonitoring-c8df000e/x`), false);
	});

	test('service-linked roles: only for the services these templates use', () => {
		const slr = (service: string) =>
			r('iam:CreateServiceLinkedRole', `${A}:iam::${acct}:role/aws-service-role/${service}/AWSServiceRoleFor`, {
				context: { 'iam:AWSServiceName': service },
			});
		for (const service of ['rds.amazonaws.com', 'dsql.amazonaws.com', 'runtime-identity.bedrock-agentcore.amazonaws.com']) {
			assert.strictEqual(slr(service), true, service);
		}
		assert.strictEqual(slr('ecs.amazonaws.com'), false);
		assert.strictEqual(
			generateExecutionPolicy(['AWS::DynamoDB::Table'], { appId: 'appa', account: acct }).document.Statement.some(
				(st) => st.Sid === 'ServiceLinkedRoles',
			),
			false,
			'none for an app that needs none',
		);
	});
});

describe('blocks-iam-policies — splitting a large execution policy', () => {
	test('the CLI splits below IAM\'s limit, so every part has room for hand additions', () => {
		assert.ok(EXECUTION_POLICY_SPLIT_CHARS <= MANAGED_POLICY_MAX_CHARS - 1000);
		const { document } = generateExecutionPolicy(['AWS::Lambda::Function', 'AWS::EC2::VPC', 'AWS::RDS::DBCluster', 'AWS::CloudFront::Distribution'], {
			appId: 'appa',
			account: acct,
		});
		for (const part of splitPolicy(document, EXECUTION_POLICY_SPLIT_CHARS)) {
			assert.ok(policySize(part) <= EXECUTION_POLICY_SPLIT_CHARS, `${policySize(part)} characters`);
		}
	});

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

describe('blocks-iam-policies — reserved app ids: no usable id reaches a shared namespace', () => {
	/** Every resource type a rule handles, so the execution policy below has every by-name rule. */
	const everyType = [
		'AWS::Lambda::Function',
		'AWS::Lambda::LayerVersion',
		'AWS::Logs::LogGroup',
		'AWS::DynamoDB::Table',
		'AWS::SQS::Queue',
		'AWS::S3::Bucket',
		'AWS::SSM::Parameter',
		'Custom::CrossRegionExportReader',
		'AWS::SecretsManager::Secret',
		'AWS::ApiGateway::RestApi',
		'AWS::Scheduler::Schedule',
		'AWS::Events::Rule',
		'AWS::Cognito::UserPool',
		'AWS::KMS::Key',
		'AWS::StepFunctions::StateMachine',
		'AWS::ResourceGroups::Group',
		'AWS::CloudWatch::Dashboard',
		'AWS::CloudWatch::Alarm',
		'AWS::SNS::Topic',
		'AWS::IAM::ManagedPolicy',
		'AWS::S3Vectors::VectorBucket',
		'AWS::DSQL::Cluster',
		'AWS::Bedrock::KnowledgeBase',
		'AWS::RDS::DBCluster',
		'AWS::EC2::VPC',
		'AWS::CloudFront::Distribution',
		'AWS::CloudFront::KeyValueStore',
		'AWS::CloudFront::Function',
	];
	const ssm = (name: string) => `${A}:ssm:us-east-1:${acct}:parameter${name}`;
	const s3 = (bucket: string) => `${A}:s3:::${bucket}/object`;
	const role = (name: string) => `${A}:iam::${acct}:role/${name}`;
	const stack = (name: string) => `${A}:cloudformation:us-east-1:${acct}:stack/${name}/uuid`;
	const cfFunction = (region: string) => `${A}:cloudfront::${acct}:function/${region}MyStackHostingFnA1B2C3D4`;

	/**
	 * Names in namespaces no app owns (or that only `owner` owns): AWS Blocks', CDK's
	 * and AWS's. Each is checked against every id-shaped token in it, since a policy
	 * pattern puts the app id between separators (`<id>-…`, `/<id>/…`, `cdk-<id>-…`).
	 */
	const shared: { action: string; arn: string; owner?: string }[] = [
		// CDK bootstrap and CDK-owned parameters.
		{ action: 's3:PutObject', arn: s3(`cdk-appb-assets-${acct}-us-east-1`), owner: 'appb' },
		{ action: 'ssm:PutParameter', arn: ssm('/cdk-bootstrap/appb/version'), owner: 'appb' },
		{ action: 'ssm:PutParameter', arn: ssm('/cdk/exports/appb-edge/x'), owner: 'appb' },
		{ action: 'ssm:PutParameter', arn: ssm('/cdk/EdgeFunctionArn/eu-west-1/appb/Hosting/Fn'), owner: 'appb' },
		{ action: 'iam:UpdateAssumeRolePolicy', arn: role(`cdk-appb-cfn-exec-role-${acct}-us-east-1`), owner: 'appb' },
		{ action: 'iam:PassRole', arn: role(`cdk-appb-deploy-role-${acct}-us-east-1`), owner: 'appb' },
		{ action: 'cloudformation:CreateChangeSet', arn: stack('CDKToolkit-appb'), owner: 'appb' },
		// Hosting's values: per app, and the shared ones of apps without a stackId.
		{ action: 'ssm:PutParameter', arn: ssm('/blocks/appb/config/FEATURE_FLAGS'), owner: 'appb' },
		{ action: 'ssm:PutParameter', arn: ssm('/blocks/config/FEATURE_FLAGS') },
		{ action: 'ssm:PutParameter', arn: ssm('/blocks/secrets/DEMO') },
		{ action: 'secretsmanager:PutSecretValue', arn: `${A}:secretsmanager:us-east-1:${acct}:secret:blocks/appb/secrets/DEMO-AbCdEf`, owner: 'appb' },
		{ action: 'secretsmanager:PutSecretValue', arn: `${A}:secretsmanager:us-east-1:${acct}:secret:blocks/secrets/DEMO-AbCdEf` },
		// AWS-owned names.
		{ action: 'ssm:GetParameter', arn: `${A}:ssm:us-east-1::parameter/aws/service/ami-amazon-linux-latest/x` },
		{ action: 's3:GetObject', arn: s3(`aws-cloudtrail-logs-${acct}-abcd1234`) },
		{ action: 's3:GetObject', arn: s3(`aws-athena-query-results-us-east-1-${acct}`) },
		{ action: 'cloudformation:DeleteStack', arn: stack('aws-sam-cli-managed-default') },
		{ action: 'cloudformation:DeleteStack', arn: stack('awseb-e-abc123-stack') },
		{ action: 'lambda:UpdateFunctionCode', arn: `${A}:lambda:us-east-1:${acct}:function:aws-controltower-NotificationForwarder` },
		{ action: 'logs:DeleteLogGroup', arn: `${A}:logs:us-east-1:${acct}:log-group:aws-controltower/CloudTrailLogs` },
		{ action: 'sns:Publish', arn: `${A}:sns:us-east-1:${acct}:aws-controltower-SecurityNotifications` },
		{ action: 'events:PutRule', arn: `${A}:events:us-east-1:${acct}:rule/aws-controltower-ConfigComplianceChangeEventRule` },
		{ action: 'iam:UpdateAssumeRolePolicy', arn: role('aws-controltower-AdministratorExecutionRole') },
		{ action: 'iam:UpdateAssumeRolePolicy', arn: role('aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_0123456789abcdef') },
		{ action: 'iam:DeleteRole', arn: role('aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS') },
		{ action: 's3:GetObject', arn: s3('cf-templates-abc123def456-us-east-1') },
		{ action: 's3:GetObject', arn: s3(`config-bucket-${acct}`) },
		{ action: 's3:GetObject', arn: s3(`sagemaker-us-east-1-${acct}`) },
		// AWS Amplify's stacks and the resources in them.
		{ action: 'cloudformation:DeleteStack', arn: stack('amplify-d1abc-main-branch-0123456789') },
		{ action: 'lambda:UpdateFunctionCode', arn: `${A}:lambda:us-east-1:${acct}:function:amplify-d1abc-main-branch-Fn` },
		{ action: 's3:GetObject', arn: s3('amplify-d1abc-main-branch-0123-deployment') },
		{ action: 'iam:UpdateAssumeRolePolicy', arn: role('amplify-d1abc-main-branch-0123-authRole') },
		// CloudFront Functions CDK named `<region>…` (any app's, before `defaults.app`).
		...['af-south-1', 'ap-southeast-2', 'ca-central-1', 'cn-north-1', 'eu-west-1', 'eusc-de-east-1', 'il-central-1', 'me-south-1', 'mx-central-1', 'sa-east-1', 'us-east-1', 'us-gov-west-1'].map((region) => ({
			action: 'cloudfront:DeleteFunction',
			arn: cfFunction(region),
		})),
	];

	/** Whether app `id`'s roles, execution role or deploy role may act on `r` (validator bypassed). */
	const reaches = (id: string, r: { action: string; arn: string }) => {
		const req = { action: r.action, arn: r.arn, principalApp: id };
		if (r.arn.includes(':cloudformation:')) {
			// Deny-only: the deploy role can act unless the guard denies it.
			const ownExec = `${A}:iam::${acct}:role/cdk-${id}-cfn-exec-role-${acct}-us-east-1`;
			const guard = generateGuardUnchecked(id);
			return !(guard.Statement as Statement[]).some((s) => s.Effect === 'Deny' && matches(s, { ...req, roleArn: ownExec }));
		}
		return allowed(generateBoundaryPolicy(), req) || allowed(generateExecutionUnchecked(id), req);
	};
	// The generators reject reserved ids, so these build the documents as if the validator allowed them.
	const generateExecutionUnchecked = (id: string) =>
		JSON.parse(JSON.stringify(generateExecutionPolicy(everyType, { appId: 'zzzz', account: acct }).document).replaceAll('zzzz', id)) as PolicyDocument;
	const generateGuardUnchecked = (id: string) =>
		JSON.parse(JSON.stringify(generateDeployGuardPolicy({ appId: 'zzzz', account: acct })).replaceAll('zzzz', id)) as PolicyDocument;
	const tokens = (arn: string) => arn.split(/[^A-Za-z0-9]+/).filter((t) => APP_ID_PATTERN.test(t));

	for (const r of shared) {
		test(`no usable app id other than its owner reaches ${r.action} ${r.arn}`, () => {
			const reaching = tokens(r.arn).filter((id) => id !== r.owner && isValidAppId(id) && reaches(id, r));
			assert.deepStrictEqual(reaching, []);
		});
	}

	test('each reserved id is needed: it reaches some shared name the policies would otherwise give it', () => {
		for (const id of Object.keys(RESERVED_APP_IDS)) {
			assert.ok(
				shared.some((r) => r.owner !== id && reaches(id, r)),
				`"${id}" is reserved but reaches nothing in the shared list: add the name it protects, or drop it`,
			);
		}
		assert.ok(shared.some((r) => reaches('aws', r)), 'the "aws" prefix protects AWS-owned names');
		assert.ok(shared.some((r) => reaches('awseb', r)), 'the "aws" prefix also covers awseb-… stacks');
	});

	test('the generators and the validator reject every reserved id and prefix', () => {
		for (const id of [...Object.keys(RESERVED_APP_IDS), ...Object.keys(RESERVED_APP_ID_PREFIXES), 'awsapp', 'ssmx']) {
			assert.strictEqual(isValidAppId(id), false, id);
			assert.throws(() => generateExecutionPolicy(everyType, { appId: id, account: acct }), /reserved/, id);
			assert.throws(() => generateDeployGuardPolicy({ appId: id, account: acct }), /reserved/, id);
		}
	});

	// A normal id: the shared boundary keeps it out of other apps' bootstrap and Hosting values.
	for (const r of [
		{ action: 's3:PutObject', arn: s3(`cdk-appb-assets-${acct}-us-east-1`) },
		{ action: 's3:GetObject', arn: s3(`cdk-appb-assets-${acct}-us-east-1`) },
		{ action: 'ssm:PutParameter', arn: ssm('/cdk/exports/appb-edge/x') },
		{ action: 'ssm:GetParameter', arn: ssm('/cdk-bootstrap/appb/version') },
		{ action: 'ssm:GetParameter', arn: ssm('/blocks/appb/config/FEATURE_FLAGS') },
		{ action: 'ssm:PutParameter', arn: ssm('/blocks/config/FEATURE_FLAGS') },
		{ action: 'secretsmanager:GetSecretValue', arn: `${A}:secretsmanager:us-east-1:${acct}:secret:blocks/secrets/DEMO-AbCdEf` },
	]) {
		test(`the boundary denies app "regx": ${r.action} ${r.arn.split(':').slice(5).join(':')}`, () => {
			assert.strictEqual(allowed(generateBoundaryPolicy(), { ...r, principalApp: 'regx' }), false);
		});
	}
});
