// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
	APP_ID_PATTERN,
	appIdProblem,
	RESERVED_APP_ID_PREFIXES,
	RESERVED_APP_IDS,
	checkApiChild,
	checkPhysicalName,
	checkResourcePolicy,
	checkResourcePolicyPrincipals,
	checkRole,
	checkStackName,
	checkStatement,
} from './app-isolation-rules.js';

const rules = (violations: { rule: string }[]) => violations.map((v) => v.rule);
const ssmArn = (name: string) => ({
	'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ssm:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, `:parameter/${name}`]],
});

describe('app-isolation rules — statements fail closed', () => {
	test('an app id is at most 10 characters (CDK qualifier limit)', () => {
		assert.ok(APP_ID_PATTERN.test('inventory1'));
		assert.ok(!APP_ID_PATTERN.test('inventoryab'));
	});

	test('reserved ids and prefixes are rejected, with the reason', () => {
		for (const [id, why] of Object.entries(RESERVED_APP_IDS)) {
			assert.ok(APP_ID_PATTERN.test(id), `${id} is id-shaped, so only the reserved list stops it`);
			assert.notStrictEqual(appIdProblem(id), undefined, id);
			assert.ok(appIdProblem(id)?.includes(why), id);
		}
		for (const [prefix, why] of Object.entries(RESERVED_APP_ID_PREFIXES)) {
			for (const id of [prefix, `${prefix}app`]) {
				assert.notStrictEqual(appIdProblem(id), undefined, id);
				assert.ok(appIdProblem(id)?.includes(why), id);
			}
		}
		for (const ok of ['orders', 'app42', 'regx', 'cdkapp', 'blocksapp', 'usa', 'awesome']) {
			assert.strictEqual(appIdProblem(ok), undefined, ok);
		}
		assert.match(appIdProblem('app-a') ?? '', /1–10 lowercase letters/);
		assert.match(appIdProblem(undefined) ?? '', /isn't an app id/);
	});

	test('NotResource on a data service is an inverse grant', () => {
		const s = { Effect: 'Allow', Action: 'ssm:GetParameter', NotResource: ssmArn('appa-x') };
		assert.deepStrictEqual(rules(checkStatement(s, 'appa', 'p')), ['inverse-grant']);
	});

	test('NotAction is an inverse grant', () => {
		const s = { Effect: 'Allow', NotAction: 'iam:*', Resource: '*' };
		assert.deepStrictEqual(rules(checkStatement(s, 'appa', 'p')), ['inverse-grant']);
	});

	test('Fn::ImportValue, a template parameter, and Fn::Sub on a parameter are unresolvable', () => {
		const params = new Set(['OtherSecret']);
		for (const resource of [
			{ 'Fn::ImportValue': 'appb-secret-arn' },
			{ Ref: 'OtherSecret' },
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a CloudFormation Fn::Sub string, not a template
			{ 'Fn::Sub': 'arn:aws:ssm:us-east-1:111111111111:parameter/${OtherSecret}' },
		]) {
			const s = { Effect: 'Allow', Action: 'ssm:GetParameter', Resource: resource };
			assert.deepStrictEqual(rules(checkStatement(s, 'appa', 'p', params)), ['unresolvable-grant'], JSON.stringify(resource));
		}
	});

	test("a reference to the template's own resource is the app's own", () => {
		const s = { Effect: 'Allow', Action: 'dynamodb:GetItem', Resource: { 'Fn::GetAtt': ['Table', 'Arn'] } };
		assert.deepStrictEqual(checkStatement(s, 'appa', 'p'), []);
	});

	test('a condition that doesn’t scope by resource tag doesn’t exempt a wildcard', () => {
		const s = {
			Effect: 'Allow',
			Action: 'dynamodb:GetItem',
			Resource: '*',
			Condition: { Bool: { 'aws:SecureTransport': 'true' } },
		};
		assert.deepStrictEqual(rules(checkStatement(s, 'appa', 'p')), ['wildcard-data-grant']);
		const tagged = { ...s, Condition: { StringEquals: { 'aws:ResourceTag/app': 'appa' } } };
		assert.deepStrictEqual(checkStatement(tagged, 'appa', 'p'), []);
	});

	test("a condition for everything except this app, or for another app, doesn't exempt a wildcard", () => {
		for (const Condition of [
			{ StringNotEquals: { 'aws:ResourceTag/app': 'appa' } },
			{ StringEquals: { 'aws:ResourceTag/app': 'appb' } },
			{ StringEquals: { 'aws:ResourceTag/app': ['appa', 'appb'] } },
			{ StringLike: { 'aws:ResourceTag/app': '*' } },
		]) {
			const s = { Effect: 'Allow', Action: 'dynamodb:GetItem', Resource: '*', Condition };
			assert.deepStrictEqual(rules(checkStatement(s, 'appa', 'p')), ['wildcard-data-grant'], JSON.stringify(Condition));
		}
		const variable = { StringEquals: { 'aws:ResourceTag/app': '$' + '{aws:PrincipalTag/app}' } };
		assert.deepStrictEqual(checkStatement({ Effect: 'Allow', Action: 'states:*', Resource: '*', Condition: variable }, 'appa', 'p'), []);
	});

	test('kms:ViaService exempts a KMS wildcard only for fenced services, and only for KMS actions', () => {
		const region = { 'Fn::Join': ['', ['ssm.', { Ref: 'AWS::Region' }, '.amazonaws.com']] };
		const kms = (via: unknown, Action: string | string[] = ['kms:Decrypt']) => ({
			Effect: 'Allow',
			Action,
			Resource: '*',
			Condition: { StringEquals: { 'kms:ViaService': via } },
		});
		assert.deepStrictEqual(checkStatement(kms(region), 'appa', 'p'), []);
		assert.deepStrictEqual(rules(checkStatement(kms('ec2.us-east-1.amazonaws.com'), 'appa', 'p')), ['wildcard-data-grant']);
		assert.deepStrictEqual(rules(checkStatement(kms(region, ['kms:Decrypt', 'dynamodb:GetItem']), 'appa', 'p')), ['wildcard-data-grant']);
	});

	test("lambda:UpdateFunctionCode and GetFunction on another app's function are flagged", () => {
		for (const action of ['lambda:UpdateFunctionCode', 'lambda:GetFunction']) {
			const s = { Effect: 'Allow', Action: action, Resource: 'arn:aws:lambda:us-east-1:111111111111:function:appb-Handler' };
			assert.deepStrictEqual(rules(checkStatement(s, 'appa', 'p')), ['grant-outside-app'], action);
		}
	});

	test('the bare <id> and <id>/… forms are the app\'s own only for SSM parameters, as in the boundary', () => {
		const grant = (action: string, resource: string) => checkStatement({ Effect: 'Allow', Action: action, Resource: resource }, 'appa', 'p');
		const arn = 'arn:aws:%s:us-east-1:111111111111:';
		for (const [action, resource] of [
			['dynamodb:GetItem', `${arn.replace('%s', 'dynamodb')}table/appa`],
			['dynamodb:GetItem', `${arn.replace('%s', 'dynamodb')}table/appa/index/x`],
			['sqs:SendMessage', `${arn.replace('%s', 'sqs')}appa`],
			['s3:GetObject', 'arn:aws:s3:::appa/x'],
			['lambda:InvokeFunction', `${arn.replace('%s', 'lambda')}function:appa`],
			['logs:PutLogEvents', `${arn.replace('%s', 'logs')}log-group:/aws/lambda/appa:*`],
		]) {
			assert.deepStrictEqual(rules(grant(action, resource)), ['grant-outside-app'], resource);
		}
		for (const name of ['appa', 'appa/x', 'appa-x']) {
			assert.deepStrictEqual(grant('ssm:GetParameter', `${arn.replace('%s', 'ssm')}parameter/${name}`), [], name);
		}
		assert.deepStrictEqual(grant('dynamodb:GetItem', `${arn.replace('%s', 'dynamodb')}table/appa-items`), []);
		assert.deepStrictEqual(checkStackName('appa', 'appa'), []);
		assert.deepStrictEqual(checkStackName('appa-web', 'appa'), []);
		assert.deepStrictEqual(rules(checkStackName('appa/x', 'appa')), ['stack-name-outside-app']);
	});

	test('iam and sts: PassRole or AssumeRole on *, or on another app\'s role, is flagged; on the app\'s own role it is not', () => {
		const grant = (action: string, resource: unknown) => rules(checkStatement({ Effect: 'Allow', Action: action, Resource: resource }, 'appa', 'p'));
		const role = (name: string) => `arn:aws:iam::111111111111:role/${name}`;
		for (const action of ['iam:PassRole', 'sts:AssumeRole']) {
			assert.deepStrictEqual(grant(action, '*'), ['wildcard-data-grant'], `${action} on *`);
			assert.deepStrictEqual(grant(action, role('*')), ['wildcard-data-grant'], `${action} on role/*`);
			assert.deepStrictEqual(grant(action, role('service-role/*')), ['wildcard-data-grant'], `${action} on role/service-role/*`);
			assert.deepStrictEqual(grant(action, role('appb-Handler')), ['grant-outside-app'], `${action} on appb-…`);
			assert.deepStrictEqual(grant(action, role('appa-Handler')), [], `${action} on appa-…`);
			assert.deepStrictEqual(grant(action, { 'Fn::GetAtt': ['HandlerRole', 'Arn'] }), [], `${action} on its own role`);
		}
	});

	test("named grants on layers, RDS (and its Data API) and S3 Vectors: another app's are outside, the app's own are inside", () => {
		const grant = (action: string, resource: string) => rules(checkStatement({ Effect: 'Allow', Action: action, Resource: resource }, 'appa', 'p'));
		const arn = (service: string, rest: string) => `arn:aws:${service}:us-east-1:111111111111:${rest}`;
		const cases: [string, (app: string) => string][] = [
			['lambda:GetLayerVersion', (a) => arn('lambda', `layer:${a}-deps:3`)],
			['rds:DescribeDBClusters', (a) => arn('rds', `cluster:${a}-db`)],
			['rds:DescribeDBInstances', (a) => arn('rds', `db:${a}-db-1`)],
			['rds-data:ExecuteStatement', (a) => arn('rds', `cluster:${a}-db`)],
			['s3vectors:QueryVectors', (a) => arn('s3vectors', `bucket/${a}-vectors`)],
			['s3vectors:QueryVectors', (a) => arn('s3vectors', `bucket/${a}-vectors/index/docs`)],
		];
		for (const [action, resource] of cases) {
			assert.deepStrictEqual(grant(action, resource('appb')), ['grant-outside-app'], resource('appb'));
			assert.deepStrictEqual(grant(action, resource('appa')), [], resource('appa'));
		}
		// A bare wildcard on these services is still a wildcard grant.
		for (const [action, resource] of [
			['s3vectors:QueryVectors', arn('s3vectors', '*')],
			['lambda:GetLayerVersion', arn('lambda', '*')],
			['rds:DescribeDBClusters', arn('rds', '*')],
		]) {
			assert.deepStrictEqual(grant(action, resource), ['wildcard-data-grant'], resource);
		}
	});

	test("another app's CDK asset bucket is outside; the app's own is inside", () => {
		const read = (bucket: string) => ({ Effect: 'Allow', Action: 's3:GetObject', Resource: `arn:aws:s3:::${bucket}/*` });
		assert.deepStrictEqual(checkStatement(read('cdk-appa-assets-111111111111-us-east-1'), 'appa', 'p'), []);
		assert.deepStrictEqual(rules(checkStatement(read('cdk-appb-assets-111111111111-us-east-1'), 'appa', 'p')), ['grant-outside-app']);
	});
});

describe('app-isolation rules — APIs', () => {
	test("a literal API id in an execute-api grant is outside the app; a reference to the app's own API is fine", () => {
		const s = (Resource: unknown) => ({ Effect: 'Allow', Action: 'execute-api:ManageConnections', Resource });
		assert.deepStrictEqual(
			rules(checkStatement(s('arn:aws:execute-api:us-east-1:111111111111:bbb222/prod/POST/@connections/*'), 'appa', 'p')),
			['grant-outside-app'],
		);
		const own = { 'Fn::Join': ['', ['arn:aws:execute-api:us-east-1:111111111111:', { Ref: 'WsApi' }, '/prod/POST/@connections/*']] };
		assert.deepStrictEqual(checkStatement(s(own), 'appa', 'p'), []);
	});

	test('an API Gateway child on a literal or unresolvable API id is flagged; one on an own API is fine', () => {
		assert.deepStrictEqual(rules(checkApiChild('AWS::ApiGateway::Stage', { RestApiId: 'bbb222', StageName: 'x' }, 'appa', 'p')), [
			'api-outside-app',
		]);
		assert.deepStrictEqual(rules(checkApiChild('AWS::ApiGatewayV2::Route', { ApiId: { 'Fn::ImportValue': 'b-api' } }, 'appa', 'p')), [
			'api-outside-app',
		]);
		assert.deepStrictEqual(checkApiChild('AWS::ApiGateway::Deployment', { RestApiId: { Ref: 'Api' } }, 'appa', 'p'), []);
	});

	test('an apigateway grant on a literal API id, or on *, is flagged', () => {
		const s = (Resource: string) => ({ Effect: 'Allow', Action: 'apigateway:POST', Resource });
		assert.deepStrictEqual(rules(checkStatement(s('arn:aws:apigateway:us-east-1::/restapis/bbb222/stages'), 'appa', 'p')), [
			'grant-outside-app',
		]);
		assert.deepStrictEqual(rules(checkStatement(s('*'), 'appa', 'p')), ['wildcard-data-grant']);
	});

	test('execute-api on * is a wildcard grant', () => {
		const s = { Effect: 'Allow', Action: 'execute-api:ManageConnections', Resource: 'arn:aws:execute-api:us-east-1:111111111111:*' };
		assert.deepStrictEqual(rules(checkStatement({ ...s, Resource: '*' }, 'appa', 'p')), ['wildcard-data-grant']);
	});
});

describe('app-isolation rules — wildcard grants on more data services', () => {
	const grant = (Action: string | string[], Resource: unknown) => ({ Effect: 'Allow', Action, Resource });
	const wildcard = (Action: string, arn: string) => {
		assert.deepStrictEqual(rules(checkStatement(grant(Action, '*'), 'appa', 'p')), ['wildcard-data-grant'], `${Action} on *`);
		assert.deepStrictEqual(rules(checkStatement(grant(Action, arn), 'appa', 'p')), ['wildcard-data-grant'], `${Action} on ${arn}`);
	};

	test('dsql: DbConnect on * or cluster/* is flagged; on its own cluster it is not', () => {
		wildcard('dsql:DbConnect', 'arn:aws:dsql:us-east-1:111111111111:cluster/*');
		const own = { 'Fn::Join': ['', ['arn:aws:dsql:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, ':cluster/', { Ref: 'Cluster' }]] };
		assert.deepStrictEqual(checkStatement(grant(['dsql:DbConnect', 'dsql:DbConnectAdmin'], own), 'appa', 'p'), []);
	});

	test('rds-data: ExecuteStatement on * or cluster:* is flagged', () => {
		wildcard('rds-data:ExecuteStatement', 'arn:aws:rds:us-east-1:111111111111:cluster:*');
	});

	test('rds: on * or db:* is flagged', () => {
		wildcard('rds:ModifyDBInstance', 'arn:aws:rds:us-east-1:111111111111:db:*');
	});

	test('bedrock: Retrieve on * or knowledge-base/* is flagged', () => {
		wildcard('bedrock:Retrieve', 'arn:aws:bedrock:us-east-1:111111111111:knowledge-base/*');
	});

	test('bedrock-agentcore: on * or runtime/* is flagged, except InvokeAgentRuntime on runtime/*', () => {
		wildcard('bedrock-agentcore:UpdateAgentRuntime', 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/*');
		const runtimes = ['arn:*:bedrock-agentcore:*:*:runtime/*', 'arn:*:bedrock-agentcore:*:*:runtime/*/*'];
		assert.deepStrictEqual(checkStatement(grant('bedrock-agentcore:InvokeAgentRuntime', runtimes), 'appa', 'p'), []);
		assert.deepStrictEqual(rules(checkStatement(grant('bedrock-agentcore:InvokeAgentRuntime', '*'), 'appa', 'p')), [
			'wildcard-data-grant',
		]);
	});

	test('s3vectors: on * or bucket/* is flagged', () => {
		wildcard('s3vectors:CreateIndex', 'arn:aws:s3vectors:us-east-1:111111111111:bucket/*');
	});

	test('sns: Publish on * or arn:…:* is flagged', () => {
		wildcard('sns:Publish', 'arn:aws:sns:us-east-1:111111111111:*');
	});

	test('ecs: on * or cluster/* is flagged', () => {
		wildcard('ecs:RunTask', 'arn:aws:ecs:us-east-1:111111111111:cluster/*');
	});

	test('ses: anything but sending, on * or identity/*, is flagged; sending is an accepted exception', () => {
		wildcard('ses:DeleteEmailIdentity', 'arn:aws:ses:us-east-1:111111111111:identity/*');
		const send = ['ses:SendEmail', 'ses:SendBulkEmail'];
		const identities = ['arn:aws:ses:*:111111111111:identity/*', 'arn:aws:ses:*:111111111111:configuration-set/*'];
		assert.deepStrictEqual(checkStatement(grant(send, identities), 'appa', 'p'), []);
		assert.deepStrictEqual(checkStatement(grant(send, '*'), 'appa', 'p'), []);
	});

	test('cloudfront-keyvaluestore: on * or key-value-store/* is flagged', () => {
		wildcard('cloudfront-keyvaluestore:UpdateKeys', 'arn:aws:cloudfront::111111111111:key-value-store/*');
	});

	test('AWS-owned Bedrock models and system inference profiles are exempt; other model resources are not', () => {
		const models = ['arn:*:bedrock:*::foundation-model/*', 'arn:*:bedrock:*:*:inference-profile/*'];
		const invoke = ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:GetFoundationModel'];
		assert.deepStrictEqual(checkStatement(grant(invoke, models), 'appa', 'p'), []);
		assert.deepStrictEqual(rules(checkStatement(grant('bedrock:InvokeModel', '*'), 'appa', 'p')), ['wildcard-data-grant']);
		assert.deepStrictEqual(
			rules(checkStatement(grant('bedrock:InvokeModel', 'arn:aws:bedrock:us-east-1:111111111111:application-inference-profile/*'), 'appa', 'p')),
			['wildcard-data-grant'],
		);
		assert.deepStrictEqual(rules(checkStatement(grant('bedrock:DeleteKnowledgeBase', models[0]), 'appa', 'p')), ['wildcard-data-grant']);
	});
});

describe('app-isolation rules — resource policies and trust', () => {
	test("a Lambda permission or queue policy on another app's resource is flagged", () => {
		assert.deepStrictEqual(
			rules(checkResourcePolicy('AWS::Lambda::Permission', { FunctionName: 'appb-Handler' }, 'appa', 'p')),
			['resource-policy-outside-app'],
		);
		assert.deepStrictEqual(
			rules(checkResourcePolicy('AWS::SQS::QueuePolicy', { Queues: ['https://sqs.us-east-1.amazonaws.com/111111111111/appb-jobs'] }, 'appa', 'p')),
			['resource-policy-outside-app'],
		);
		assert.deepStrictEqual(checkResourcePolicy('AWS::Lambda::Permission', { FunctionName: { 'Fn::GetAtt': ['Fn', 'Arn'] } }, 'appa', 'p'), []);
		assert.deepStrictEqual(checkResourcePolicy('AWS::S3::BucketPolicy', { Bucket: 'appa-files' }, 'appa', 'p'), []);
	});

	test('a role that trusts an account or a federated identity is flagged; a service principal is fine', () => {
		const role = (Principal: unknown) => ({
			AssumeRolePolicyDocument: { Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal }] },
			Tags: [{ Key: 'app', Value: 'appa' }],
		});
		assert.deepStrictEqual(rules(checkRole(role({ AWS: 'arn:aws:iam::222222222222:root' }), 'appa', 'p', false)), ['role-trust-not-service']);
		assert.deepStrictEqual(rules(checkRole(role('*'), 'appa', 'p', false)), ['role-trust-not-service']);
		assert.deepStrictEqual(checkRole(role({ Service: 'lambda.amazonaws.com' }), 'appa', 'p', false), []);
	});
});

describe('app-isolation rules — names the app gives its own resources', () => {
	const check = (type: string, props: Record<string, unknown>) => rules(checkPhysicalName(type, props, 'appa', 'p'));

	test("a literal name outside the prefix on a name-fenced type is flagged; the app's own, or a generated one, is not", () => {
		const cases: [string, string, string, string][] = [
			['AWS::DynamoDB::Table', 'TableName', 'appb-items', 'appa-items'],
			['AWS::SQS::Queue', 'QueueName', 'appb-jobs', 'appa-jobs'],
			['AWS::S3::Bucket', 'BucketName', 'appb-files', 'appa-files'],
			['AWS::Lambda::Function', 'FunctionName', 'appb-handler', 'appa-handler'],
			['AWS::Lambda::LayerVersion', 'LayerName', 'appb-deps', 'appa-deps'],
			['AWS::SSM::Parameter', 'Name', '/appb-setting', '/appa/setting'],
			['AWS::Logs::LogGroup', 'LogGroupName', '/aws/lambda/appb-handler', '/aws/lambda/appa-handler'],
			['AWS::RDS::DBCluster', 'DBClusterIdentifier', 'appb-db', 'appa-db'],
			['AWS::RDS::DBInstance', 'DBInstanceIdentifier', 'appb-db-1', 'appa-db-1'],
			['AWS::Events::Rule', 'Name', 'appb-nightly', 'appa-nightly'],
			['AWS::Scheduler::Schedule', 'Name', 'appb-report', 'appa-report'],
			['AWS::SecretsManager::Secret', 'Name', 'appb-api-key', 'appa-api-key'],
			['AWS::StepFunctions::StateMachine', 'StateMachineName', 'appb-flow', 'appa-flow'],
		];
		for (const [type, prop, outside, own] of cases) {
			assert.deepStrictEqual(check(type, { [prop]: outside }), ['scope-outside-app'], `${type} ${outside}`);
			assert.deepStrictEqual(check(type, { [prop]: own }), [], `${type} ${own}`);
			assert.deepStrictEqual(check(type, {}), [], `${type} with a generated name`);
		}
	});

	test('a table named <id> without the hyphen is outside (only SSM takes the bare id); a name with a reference is not judged', () => {
		assert.deepStrictEqual(check('AWS::DynamoDB::Table', { TableName: 'appa' }), ['scope-outside-app']);
		assert.deepStrictEqual(check('AWS::SSM::Parameter', { Name: 'appa' }), []);
		assert.deepStrictEqual(check('AWS::SSM::Parameter', { Name: '/blocks/appa/config/x' }), []);
		assert.deepStrictEqual(check('AWS::SSM::Parameter', { Name: '/cdk/EdgeFunctionArn/eu-west-1/appa/Fn' }), []);
		assert.deepStrictEqual(check('AWS::SSM::Parameter', { Name: '/cdk/EdgeFunctionArn/eu-west-1/appb/Fn' }), ['scope-outside-app']);
		assert.deepStrictEqual(check('AWS::Logs::LogGroup', { LogGroupName: '/aws/rds/cluster/appa-db/postgresql' }), []);
		assert.deepStrictEqual(check('AWS::RDS::DBCluster', { DBClusterIdentifier: 'APPA-DB' }), [], 'RDS lowercases identifiers');
		const withRef = { 'Fn::Join': ['-', [{ Ref: 'AWS::StackName' }, 'items']] };
		assert.deepStrictEqual(check('AWS::DynamoDB::Table', { TableName: withRef }), []);
		assert.deepStrictEqual(check('AWS::Kinesis::Stream', { Name: 'appb-events' }), [], 'not a name-fenced type');
	});
});

describe('app-isolation rules — who a resource policy lets in', () => {
	const ACCOUNT = '111111111111';
	const check = (type: string, props: Record<string, unknown>) =>
		rules(checkResourcePolicyPrincipals(type, props, 'appa', 'p', new Set(), ACCOUNT));
	const doc = (statement: Record<string, unknown>) => ({ PolicyDocument: { Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*', ...statement }] } });
	const bucket = (statement: Record<string, unknown>) => check('AWS::S3::BucketPolicy', doc(statement));
	const role = (name: string, account = ACCOUNT) => `arn:aws:iam::${account}:role/${name}`;

	test('a Lambda permission: everyone, another account or a public function URL is flagged; a service, the account or an IAM-authorized URL is not', () => {
		const permission = (props: Record<string, unknown>) => check('AWS::Lambda::Permission', { Action: 'lambda:InvokeFunction', FunctionName: { Ref: 'Fn' }, ...props });
		assert.deepStrictEqual(permission({ Principal: '*' }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(permission({ Principal: '*', FunctionUrlAuthType: 'NONE' }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(permission({ Principal: '222222222222' }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(permission({ Principal: role('appb-Caller') }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(permission({ Principal: '*', FunctionUrlAuthType: 'AWS_IAM' }), []);
		assert.deepStrictEqual(permission({ Principal: 'apigateway.amazonaws.com', SourceArn: { 'Fn::GetAtt': ['Api', 'Arn'] } }), []);
		assert.deepStrictEqual(permission({ Principal: ACCOUNT }), []);
		assert.deepStrictEqual(permission({ Principal: role('appa-Caller') }), []);
	});

	test("a policy document: everyone, another account, another app's role or NotPrincipal is flagged", () => {
		assert.deepStrictEqual(bucket({ Principal: '*' }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(bucket({ Principal: { AWS: '*' } }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(bucket({ Principal: { AWS: 'arn:aws:iam::222222222222:root' } }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(bucket({ Principal: { AWS: role('appb-Handler') } }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(bucket({ Principal: { AWS: [role('appa-Handler'), role('appb-Handler')] } }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(bucket({ NotPrincipal: { AWS: role('appa-Handler') } }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(bucket({ Principal: { Federated: 'cognito-identity.amazonaws.com' } }), ['resource-policy-outside-app']);
	});

	test("a policy document: a service, the app's own role, a role named <id>-… or this account's root is fine; a Deny is never flagged", () => {
		assert.deepStrictEqual(bucket({ Principal: { Service: 'cloudfront.amazonaws.com' } }), []);
		assert.deepStrictEqual(bucket({ Principal: { AWS: { 'Fn::GetAtt': ['HandlerRole', 'Arn'] } } }), []);
		assert.deepStrictEqual(bucket({ Principal: { AWS: role('appa-Handler') } }), []);
		assert.deepStrictEqual(bucket({ Principal: { AWS: role('service-role/appa-Handler') } }), []);
		const accountRoot = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, ':root']] };
		assert.deepStrictEqual(bucket({ Principal: { AWS: accountRoot } }), []);
		assert.deepStrictEqual(bucket({ Principal: { AWS: { Ref: 'AWS::AccountId' } } }), []);
		assert.deepStrictEqual(bucket({ Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` } }), []);
		assert.deepStrictEqual(check('AWS::S3::BucketPolicy', { PolicyDocument: { Statement: [{ Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: '*' }] } }), []);
	});

	test("everyone is fine only when a condition pins it to this app: its own ARNs here, or its app tag with this account; the account alone isn't enough", () => {
		const scoped = (condition: Record<string, unknown>) => bucket({ Principal: { AWS: '*' }, Condition: condition });
		assert.deepStrictEqual(scoped({ ArnLike: { 'aws:PrincipalArn': role('appa-*') } }), []);
		const pseudoRole = { 'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'AWS::AccountId' }, ':role/appa-*']] };
		assert.deepStrictEqual(scoped({ ArnLike: { 'aws:PrincipalArn': pseudoRole } }), []);
		assert.deepStrictEqual(scoped({ ArnEquals: { 'aws:SourceArn': { 'Fn::GetAtt': ['Distribution', 'Arn'] } } }), []);
		assert.deepStrictEqual(
			scoped({ StringEquals: { 'aws:PrincipalTag/app': 'appa', 'aws:PrincipalAccount': { Ref: 'AWS::AccountId' } } }),
			[],
		);
		assert.deepStrictEqual(scoped({ StringEquals: { 'aws:PrincipalTag/app': 'appa', 'aws:PrincipalAccount': ACCOUNT } }), []);
		// The tag alone: the caller's own account sets it, so another account can tag its role app=appa.
		assert.deepStrictEqual(scoped({ StringEquals: { 'aws:PrincipalTag/app': 'appa' } }), ['resource-policy-outside-app']);
		// The app's role name in another account, or in every account (a literal `*`).
		assert.deepStrictEqual(scoped({ ArnLike: { 'aws:PrincipalArn': role('appa-*', '999999999999') } }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(scoped({ ArnLike: { 'aws:PrincipalArn': 'arn:aws:iam::*:role/appa-*' } }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(scoped({ ArnLike: { 'aws:PrincipalArn': role('appb-*') } }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(scoped({ StringEquals: { 'aws:PrincipalTag/app': 'appb' } }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(scoped({ StringEquals: { 'aws:SourceAccount': ACCOUNT } }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(scoped({ StringEquals: { 'aws:PrincipalAccount': ACCOUNT } }), ['resource-policy-outside-app']);
	});

	test('a condition pin lets in only everyone (*), never a named principal from another account or app', () => {
		const tagPin = { StringEquals: { 'aws:PrincipalTag/app': 'appa', 'aws:PrincipalAccount': ACCOUNT } };
		// aws:PrincipalTag is set by the caller's own account, so another account can tag its role app=appa.
		assert.deepStrictEqual(bucket({ Principal: { AWS: 'arn:aws:iam::999999999999:role/evil' }, Condition: tagPin }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(bucket({ Principal: { AWS: role('appb-Handler') }, Condition: tagPin }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(bucket({ Principal: { Federated: 'cognito-identity.amazonaws.com' }, Condition: tagPin }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(bucket({ Principal: { AWS: '*' }, Condition: tagPin }), []);
		assert.deepStrictEqual(bucket({ Principal: '*', Condition: tagPin }), []);
	});

	test('EventBridge bus policies and KMS replica keys are read too', () => {
		const outsider = { Effect: 'Allow', Principal: { AWS: '222222222222' }, Action: 'events:PutEvents', Resource: '*' };
		assert.deepStrictEqual(check('AWS::Events::EventBus', { Name: 'appa-bus', Policy: { Statement: [outsider] } }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(check('AWS::KMS::ReplicaKey', { KeyPolicy: { Statement: [outsider] } }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(check('AWS::Events::EventBusPolicy', { StatementId: 's', Statement: outsider }), ['resource-policy-outside-app']);
		// The legacy form names the principal (an account id or *) directly.
		assert.deepStrictEqual(check('AWS::Events::EventBusPolicy', { StatementId: 's', Action: 'events:PutEvents', Principal: '222222222222' }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(check('AWS::Events::EventBusPolicy', { StatementId: 's', Action: 'events:PutEvents', Principal: '*' }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(check('AWS::Events::EventBusPolicy', { StatementId: 's', Action: 'events:PutEvents', Principal: ACCOUNT }), []);
		assert.deepStrictEqual(check('AWS::Events::EventBus', { Name: 'appa-bus' }), [], 'no policy');
	});

	test("a policy the check can't read (an intrinsic, a string) fails closed", () => {
		const conditional = { 'Fn::If': ['IsProd', { Statement: [] }, { Statement: [] }] };
		assert.deepStrictEqual(check('AWS::S3::BucketPolicy', { PolicyDocument: conditional }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(check('AWS::KMS::Key', { KeyPolicy: '{"Statement":[]}' }), ['resource-policy-outside-app']);
		assert.deepStrictEqual(check('AWS::Events::EventBusPolicy', { StatementId: 's', Statement: conditional }), ['resource-policy-outside-app']);
		// A single statement object (not in a list) is valid IAM and is read.
		assert.deepStrictEqual(check('AWS::S3::BucketPolicy', { PolicyDocument: { Statement: { Effect: 'Allow', Principal: { Service: 'cloudfront.amazonaws.com' }, Action: 's3:GetObject', Resource: '*' } } }), []);
	});

	test("a KMS key policy, a queue, topic or secret policy and an API's resource policy are read the same way", () => {
		const statement = { Effect: 'Allow', Principal: { AWS: role('appb-Handler') }, Action: '*', Resource: '*' };
		for (const [type, key] of [
			['AWS::KMS::Key', 'KeyPolicy'],
			['AWS::SQS::QueuePolicy', 'PolicyDocument'],
			['AWS::SNS::TopicPolicy', 'PolicyDocument'],
			['AWS::SecretsManager::ResourcePolicy', 'ResourcePolicy'],
			['AWS::ApiGateway::RestApi', 'Policy'],
		]) {
			assert.deepStrictEqual(check(type, { [key]: { Statement: [statement] } }), ['resource-policy-outside-app'], type);
			assert.deepStrictEqual(check(type, { [key]: { Statement: [{ ...statement, Principal: { AWS: role('appa-Handler') } }] } }), [], type);
		}
		assert.deepStrictEqual(check('AWS::DynamoDB::Table', { TableName: 'x' }), [], 'not a resource policy');
		// A public REST API (Hosting's origin-verify policy) lets in everyone, and denies requests without its secret header.
		const publicApi = { Statement: [{ Effect: 'Allow', Principal: '*', Action: 'execute-api:Invoke', Resource: 'execute-api:/*' }] };
		assert.deepStrictEqual(check('AWS::ApiGateway::RestApi', { Policy: publicApi }), []);
		assert.deepStrictEqual(check('AWS::ApiGateway::RestApi', { Policy: { Statement: [{ ...publicApi.Statement[0], Principal: { AWS: '*' } }] } }), []);
	});
});

describe('app-isolation rules — CDK cross-region references and Hosting stores', () => {
	const ssm = (name: string) => `arn:*:ssm:us-east-1:111111111111:parameter/${name}`;

	test("CDK's cross-region export writer on /cdk/exports/* is a known exemption; the same wildcard otherwise is not", () => {
		const writer = {
			Effect: 'Allow',
			Action: ['ssm:DeleteParameters', 'ssm:ListTagsForResource', 'ssm:GetParameters', 'ssm:PutParameter'],
			Resource: ssm('cdk/exports/*'),
		};
		assert.deepStrictEqual(checkStatement(writer, 'appa', 'p'), []);
		assert.deepStrictEqual(rules(checkStatement({ ...writer, Action: ['ssm:GetParameter', 'ssm:GetParametersByPath'] }, 'appa', 'p')), [
			'wildcard-data-grant',
		]);
		assert.deepStrictEqual(rules(checkStatement({ ...writer, Resource: ssm('*') }, 'appa', 'p')), ['wildcard-data-grant']);
	});

	test("the export reader on the app's own stack's exports is the app's own; another app's is outside", () => {
		const reader = (stack: string) => ({
			Effect: 'Allow',
			Action: ['ssm:AddTagsToResource', 'ssm:RemoveTagsFromResource', 'ssm:GetParameters'],
			Resource: ssm(`cdk/exports/${stack}/*`),
		});
		assert.deepStrictEqual(checkStatement(reader('appa-CfMonitoring-c8df000e'), 'appa', 'p'), []);
		assert.deepStrictEqual(rules(checkStatement(reader('appb-CfMonitoring-c8df000e'), 'appa', 'p')), ['grant-outside-app']);
	});

	test("CDK's Lambda@Edge ARN reader (GetParameter on /cdk/EdgeFunctionArn/*) is a known exemption, read only", () => {
		const s = { Effect: 'Allow', Action: 'ssm:GetParameter', Resource: ssm('cdk/EdgeFunctionArn/*') };
		assert.deepStrictEqual(checkStatement(s, 'appa', 'p'), []);
		assert.deepStrictEqual(rules(checkStatement({ ...s, Action: 'ssm:PutParameter' }, 'appa', 'p')), ['grant-outside-app']);
	});

	test("Hosting secret()/config() under blocks/<id>/ are the app's own; other blocks/ names are flagged with the stackId hint", () => {
		const sm = (name: string) => ({
			Effect: 'Allow',
			Action: 'secretsmanager:GetSecretValue',
			Resource: `arn:*:secretsmanager:us-east-1:111111111111:secret:${name}-??????`,
		});
		const cfg = (name: string) => ({ Effect: 'Allow', Action: 'ssm:GetParameter', Resource: ssm(name) });
		assert.deepStrictEqual(checkStatement(sm('blocks/appa/secrets/DEMO_SECRET'), 'appa', 'p'), []);
		assert.deepStrictEqual(checkStatement(cfg('blocks/appa/config/FEATURE_FLAGS'), 'appa', 'p'), []);
		for (const s of [sm('blocks/secrets/DEMO_SECRET'), sm('blocks/appb/secrets/X'), cfg('blocks/config/FEATURE_FLAGS'), cfg('blocks/appab/config/X')]) {
			const v = checkStatement(s, 'appa', 'p');
			assert.deepStrictEqual(rules(v), ['grant-outside-app'], JSON.stringify(s.Resource));
			assert.match(v[0].message, /stackId.*\.cdk-blocks\/config\.json.*"appa"/);
		}
	});
});
