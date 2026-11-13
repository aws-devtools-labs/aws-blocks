// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { type ConsoleLink, consoleLink, friendlyType, stackResourcesUrl } from './console-links.js';

const REGION = 'us-east-1';
const STACK = 'my-stack';
const STACK_RESOURCES_URL =
	'https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/resources?stackName=my-stack';

/** Every mapped type, so the "no `undefined` anywhere" sweep cannot silently miss one. */
const MAPPED_TYPES = [
	'AWS::DynamoDB::Table',
	'AWS::Lambda::Function',
	'AWS::Cognito::UserPool',
	'AWS::S3::Bucket',
	'AWS::CloudFront::Distribution',
	'AWS::ApiGateway::RestApi',
	'AWS::ApiGatewayV2::Api',
	'AWS::SQS::Queue',
	'AWS::SNS::Topic',
	'AWS::Logs::LogGroup',
	'AWS::StepFunctions::StateMachine',
	'AWS::Events::Rule',
	'AWS::SecretsManager::Secret',
	'AWS::SSM::Parameter',
	'AWS::IAM::Role',
];

/** Asserts a direct link with an exact URL, so a route change fails loudly. */
function assertDirect(link: ConsoleLink | undefined, url: string): void {
	assert.ok(link, 'expected a link');
	assert.strictEqual(link.url, url);
	assert.strictEqual(link.direct, true);
}

describe('consoleLink — direct links, one per mapped type', () => {
	it('DynamoDB table', () => {
		assertDirect(
			consoleLink('AWS::DynamoDB::Table', 'my-table', STACK, REGION),
			'https://us-east-1.console.aws.amazon.com/dynamodbv2/home?region=us-east-1#table?name=my-table',
		);
	});

	it('Lambda function', () => {
		assertDirect(
			consoleLink('AWS::Lambda::Function', 'my-fn', STACK, REGION),
			'https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/my-fn',
		);
	});

	it('Cognito user pool', () => {
		assertDirect(
			consoleLink('AWS::Cognito::UserPool', 'us-east-1_AbCd1234', STACK, REGION),
			'https://us-east-1.console.aws.amazon.com/cognito/v2/idp/user-pools/us-east-1_AbCd1234/users?region=us-east-1',
		);
	});

	it('S3 bucket', () => {
		assertDirect(
			consoleLink('AWS::S3::Bucket', 'my-bucket', STACK, REGION),
			'https://us-east-1.console.aws.amazon.com/s3/buckets/my-bucket?region=us-east-1',
		);
	});

	it('CloudFront distribution', () => {
		assertDirect(
			consoleLink('AWS::CloudFront::Distribution', 'E1AB2CD3EF4GH5', STACK, REGION),
			'https://console.aws.amazon.com/cloudfront/v4/home#/distributions/E1AB2CD3EF4GH5',
		);
	});

	it('API Gateway REST API', () => {
		assertDirect(
			consoleLink('AWS::ApiGateway::RestApi', 'abc123defg', STACK, REGION),
			'https://us-east-1.console.aws.amazon.com/apigateway/main/apis/abc123defg/resources?region=us-east-1',
		);
	});

	it('API Gateway v2 API', () => {
		assertDirect(
			consoleLink('AWS::ApiGatewayV2::Api', 'xyz789hijk', STACK, REGION),
			'https://us-east-1.console.aws.amazon.com/apigateway/main/api-detail?region=us-east-1&api=xyz789hijk',
		);
	});

	it('SQS queue', () => {
		assertDirect(
			consoleLink('AWS::SQS::Queue', 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue', STACK, REGION),
			'https://us-east-1.console.aws.amazon.com/sqs/v3/home?region=us-east-1#/queues/https%3A%2F%2Fsqs.us-east-1.amazonaws.com%2F123456789012%2Fmy-queue',
		);
	});

	it('SNS topic', () => {
		assertDirect(
			consoleLink('AWS::SNS::Topic', 'arn:aws:sns:us-east-1:123456789012:my-topic', STACK, REGION),
			'https://us-east-1.console.aws.amazon.com/sns/v3/home?region=us-east-1#/topic/arn:aws:sns:us-east-1:123456789012:my-topic',
		);
	});

	it('CloudWatch log group', () => {
		assertDirect(
			consoleLink('AWS::Logs::LogGroup', '/aws/lambda/my-fn', STACK, REGION),
			'https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/$252Faws$252Flambda$252Fmy-fn',
		);
	});

	it('Step Functions state machine', () => {
		assertDirect(
			consoleLink(
				'AWS::StepFunctions::StateMachine',
				'arn:aws:states:us-east-1:123456789012:stateMachine:my-sm',
				STACK,
				REGION,
			),
			'https://us-east-1.console.aws.amazon.com/states/home?region=us-east-1#/statemachines/view/arn:aws:states:us-east-1:123456789012:stateMachine:my-sm',
		);
	});

	it('EventBridge rule', () => {
		assertDirect(
			consoleLink('AWS::Events::Rule', 'my-rule', STACK, REGION),
			'https://us-east-1.console.aws.amazon.com/events/home?region=us-east-1#/eventbus/default/rules/my-rule',
		);
	});

	it('Secrets Manager secret', () => {
		assertDirect(
			consoleLink('AWS::SecretsManager::Secret', 'my-secret', STACK, REGION),
			'https://us-east-1.console.aws.amazon.com/secretsmanager/secret?name=my-secret&region=us-east-1',
		);
	});

	it('SSM parameter', () => {
		assertDirect(
			consoleLink('AWS::SSM::Parameter', 'my-param', STACK, REGION),
			'https://us-east-1.console.aws.amazon.com/systems-manager/parameters/my-param/description?region=us-east-1',
		);
	});

	it('IAM role', () => {
		assertDirect(
			consoleLink('AWS::IAM::Role', 'my-role', STACK, REGION),
			'https://console.aws.amazon.com/iam/home#/roles/my-role',
		);
	});
});

describe('consoleLink — encoding rules that are easy to break', () => {
	it('double-encodes log group slashes into the literal $252F form', () => {
		const link = consoleLink('AWS::Logs::LogGroup', '/aws/lambda/my-fn', STACK, REGION);
		assert.ok(link);
		assert.ok(link.url.endsWith('/log-group/$252Faws$252Flambda$252Fmy-fn'), link.url);
		// A single round of encoding is the failure mode: it must NOT appear.
		assert.ok(!link.url.includes('%2Faws'), 'log group must not be single-encoded');
		// Nor may a raw slash survive inside the log group name.
		assert.ok(!link.url.includes('log-group//aws/lambda'), 'log group slashes must be encoded');
		assert.strictEqual(link.url.split('$252F').length - 1, 3, 'one $252F per slash');
	});

	it('URI-encodes an SQS queue URL into a single fragment segment', () => {
		const queueUrl = 'https://sqs.eu-west-1.amazonaws.com/123456789012/orders.fifo';
		const link = consoleLink('AWS::SQS::Queue', queueUrl, STACK, 'eu-west-1');
		assert.ok(link);
		assert.ok(link.url.endsWith(`#/queues/${encodeURIComponent(queueUrl)}`), link.url);
		assert.ok(link.url.includes('https%3A%2F%2Fsqs.eu-west-1.amazonaws.com%2F123456789012%2Forders.fifo'));
		// The queue URL's own scheme must not survive unencoded inside the fragment.
		assert.ok(!link.url.includes('#/queues/https://'), 'queue URL must be encoded');
	});

	it('URI-encodes a hierarchical SSM parameter name, leaving no empty path segment', () => {
		const link = consoleLink('AWS::SSM::Parameter', '/app/db/password', STACK, REGION);
		assert.ok(link);
		assert.strictEqual(
			link.url,
			'https://us-east-1.console.aws.amazon.com/systems-manager/parameters/%2Fapp%2Fdb%2Fpassword/description?region=us-east-1',
		);
		assert.ok(!link.url.includes('parameters//'), 'must not contain an empty path segment');
	});
});

describe('consoleLink — global services carry no region', () => {
	it('CloudFront has no region in the host and none in the query', () => {
		const link = consoleLink('AWS::CloudFront::Distribution', 'E1AB2CD3EF4GH5', STACK, REGION);
		assert.ok(link);
		assert.ok(link.url.startsWith('https://console.aws.amazon.com/'), link.url);
		assert.ok(!link.url.includes('region='), 'no region qualifier');
		assert.ok(!link.url.includes(REGION), 'no region anywhere in the URL');
	});

	it('IAM has no region in the host and none in the query', () => {
		const link = consoleLink('AWS::IAM::Role', 'my-role', STACK, 'eu-west-1');
		assert.ok(link);
		assert.ok(link.url.startsWith('https://console.aws.amazon.com/'), link.url);
		assert.ok(!link.url.includes('region='), 'no region qualifier');
		assert.ok(!link.url.includes('eu-west-1'), 'no region anywhere in the URL');
	});
});

describe('consoleLink — fallbacks', () => {
	it('falls back to the stack Resources tab for an unmapped type', () => {
		const link = consoleLink('AWS::EC2::VPC', 'vpc-0abc123', STACK, REGION);
		assert.deepStrictEqual(link, { url: STACK_RESOURCES_URL, direct: false });
	});

	it('falls back for a mapped type whose physical id is not known yet', () => {
		const link = consoleLink('AWS::DynamoDB::Table', undefined, STACK, REGION);
		assert.deepStrictEqual(link, { url: STACK_RESOURCES_URL, direct: false });
	});

	it('falls back for a mapped type whose physical id is empty', () => {
		const link = consoleLink('AWS::Lambda::Function', '   ', STACK, REGION);
		assert.deepStrictEqual(link, { url: STACK_RESOURCES_URL, direct: false });
	});

	it('returns undefined for an unmapped type with no stack name', () => {
		assert.strictEqual(consoleLink('AWS::EC2::VPC', 'vpc-0abc123', undefined, REGION), undefined);
	});

	it('returns undefined when there is neither a physical id nor a stack name', () => {
		assert.strictEqual(consoleLink('AWS::DynamoDB::Table', undefined, undefined, REGION), undefined);
	});

	it('returns undefined for an empty stack name rather than a URL with a hole in it', () => {
		assert.strictEqual(consoleLink('AWS::EC2::VPC', undefined, '  ', REGION), undefined);
	});

	it('still links directly when the stack name is unknown but the physical id is not', () => {
		assertDirect(
			consoleLink('AWS::S3::Bucket', 'my-bucket', undefined, REGION),
			'https://us-east-1.console.aws.amazon.com/s3/buckets/my-bucket?region=us-east-1',
		);
	});

	it('does not throw on empty inputs', () => {
		assert.strictEqual(consoleLink('', '', '', ''), undefined);
	});
});

describe('stackResourcesUrl', () => {
	it('points at the stack Resources tab', () => {
		assert.strictEqual(stackResourcesUrl(STACK, REGION), STACK_RESOURCES_URL);
	});

	it('encodes the stack name', () => {
		assert.ok(stackResourcesUrl('my stack', REGION).endsWith('stackName=my%20stack'));
	});
});

describe('friendlyType', () => {
	it('derives a label from the resource type', () => {
		assert.strictEqual(friendlyType('AWS::DynamoDB::Table'), 'DynamoDB Table');
		assert.strictEqual(friendlyType('AWS::Lambda::Function'), 'Lambda Function');
		assert.strictEqual(friendlyType('AWS::Cognito::UserPool'), 'Cognito User Pool');
		assert.strictEqual(friendlyType('AWS::S3::Bucket'), 'S3 Bucket');
		assert.strictEqual(friendlyType('AWS::Logs::LogGroup'), 'Logs Log Group');
		assert.strictEqual(friendlyType('AWS::StepFunctions::StateMachine'), 'StepFunctions State Machine');
		assert.strictEqual(friendlyType('AWS::ApiGateway::RestApi'), 'ApiGateway Rest Api');
	});

	it('splits a trailing version segment off the service name', () => {
		assert.strictEqual(friendlyType('AWS::ApiGatewayV2::Api'), 'ApiGateway V2 Api');
		assert.strictEqual(
			friendlyType('AWS::ElasticLoadBalancingV2::LoadBalancer'),
			'ElasticLoadBalancing V2 Load Balancer',
		);
	});

	it('keeps acronym-style service names intact', () => {
		assert.strictEqual(friendlyType('AWS::SQS::Queue'), 'SQS Queue');
		assert.strictEqual(friendlyType('AWS::IAM::Role'), 'IAM Role');
	});

	it('handles non-AWS and malformed types without throwing', () => {
		assert.strictEqual(friendlyType('Custom::MyThing'), 'MyThing');
		assert.strictEqual(friendlyType('Bare'), 'Bare');
		assert.strictEqual(friendlyType(''), '');
		assert.strictEqual(friendlyType('AWS::'), 'AWS');
	});
});

describe('no output ever contains the substring "undefined"', () => {
	it('holds for every mapped type, with and without a physical id', () => {
		for (const type of MAPPED_TYPES) {
			for (const id of ['some-id', undefined]) {
				for (const stack of [STACK, undefined]) {
					const link = consoleLink(type, id, stack, REGION);
					if (link) {
						assert.ok(!link.url.includes('undefined'), `${type}: ${link.url}`);
					}
				}
			}
			assert.ok(!friendlyType(type).includes('undefined'), type);
		}
	});

	it('holds for an unmapped type and for the stack fallback', () => {
		const link = consoleLink('AWS::EC2::Instance', undefined, STACK, REGION);
		assert.ok(link);
		assert.ok(!link.url.includes('undefined'));
		assert.ok(!stackResourcesUrl(STACK, REGION).includes('undefined'));
	});
});
