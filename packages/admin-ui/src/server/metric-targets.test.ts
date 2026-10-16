// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RawStackResource } from './log-groups.js';
import type { RawTemplate } from './resources.js';
import {
	type MetricTarget,
	discoverMetricTargets,
	findRestApiStage,
	metricRegion,
	resourcesToMetricTargets,
	restApiNamesByPhysicalId,
	shortLabel,
	targetKey,
	templateRestApiNames,
} from './metric-targets.js';

/*
 * The fixtures mirror a real two-stage deployment, with the account and the
 * resource ids replaced. The detail that matters and could not have been
 * guessed: BOTH stacks' REST APIs are named `Blocks API` and both use stage
 * `prod`, so their CloudWatch dimension sets are identical while every other
 * resource separates on a stack-prefixed physical name.
 */
const PROD_STACK = 'rota-3a4f18-prod';
const SANDBOX_STACK = 'rota-3a4f18-dev-bf9209';

function stackResources(stack: string, restApiId: string, wsApiId: string): RawStackResource[] {
	return [
		{ LogicalResourceId: 'API62EA1CFF', ResourceType: 'AWS::ApiGateway::RestApi', PhysicalResourceId: restApiId },
		{
			LogicalResourceId: 'APIDeploymentStageprod278E75BA',
			ResourceType: 'AWS::ApiGateway::Stage',
			PhysicalResourceId: 'prod',
		},
		{
			LogicalResourceId: 'BlocksRtWebSocket2B4B3773',
			ResourceType: 'AWS::ApiGatewayV2::Api',
			PhysicalResourceId: wsApiId,
		},
		{
			LogicalResourceId: 'StaffTable',
			ResourceType: 'AWS::DynamoDB::Table',
			PhysicalResourceId: `${stack}-rota-staff`,
		},
		{
			LogicalResourceId: 'AuthFn',
			ResourceType: 'AWS::Lambda::Function',
			PhysicalResourceId: `${stack}-BlocksGsiManagerC334E3EE-4iy35myTDg05`,
		},
		// Not a metric target: no CloudWatch namespace of its own.
		{ LogicalResourceId: 'ApiRole', ResourceType: 'AWS::IAM::Role', PhysicalResourceId: `${stack}-role` },
	];
}

const TEMPLATE: RawTemplate = {
	Resources: {
		API62EA1CFF: { Type: 'AWS::ApiGateway::RestApi', Properties: { Name: 'Blocks API' } },
	},
};

describe('templateRestApiNames', () => {
	it('reads a literal REST API name from the template', () => {
		assert.deepEqual([...templateRestApiNames(TEMPLATE)], [['API62EA1CFF', 'Blocks API']]);
	});

	it('skips a name that is a CloudFormation intrinsic, not a literal', () => {
		// A serialised intrinsic as a dimension selects nothing, so it must not
		// become a target at all rather than producing an empty chart.
		const names = templateRestApiNames({
			Resources: { Api: { Type: 'AWS::ApiGateway::RestApi', Properties: { Name: { Ref: 'ApiNameParam' } } } },
		});
		assert.equal(names.size, 0);
	});

	it('ignores resources of other types', () => {
		const names = templateRestApiNames({
			Resources: { T: { Type: 'AWS::DynamoDB::Table', Properties: { Name: 'not-an-api' } } },
		});
		assert.equal(names.size, 0);
	});

	it('returns empty for a template with no resources', () => {
		assert.equal(templateRestApiNames({}).size, 0);
	});
});

describe('restApiNamesByPhysicalId', () => {
	it('re-keys template names from logical onto physical ids', () => {
		const resources = stackResources(PROD_STACK, 'a1b2c3d4e5', 'f6g7h8i9j0');
		assert.deepEqual([...restApiNamesByPhysicalId(resources, TEMPLATE)], [['a1b2c3d4e5', 'Blocks API']]);
	});

	it('yields no entry when the stack resource has no physical id yet', () => {
		const names = restApiNamesByPhysicalId(
			[{ LogicalResourceId: 'API62EA1CFF', ResourceType: 'AWS::ApiGateway::RestApi' }],
			TEMPLATE,
		);
		assert.equal(names.size, 0);
	});
});

describe('resourcesToMetricTargets', () => {
	it('maps each supported type to its own namespace and dimension', () => {
		const targets = resourcesToMetricTargets(stackResources(PROD_STACK, 'a1b2c3d4e5', 'f6g7h8i9j0'), {
			stackName: PROD_STACK,
			apiNames: new Map([['a1b2c3d4e5', 'Blocks API']]),
			restApiStage: 'prod',
		});
		const byKind = new Map(targets.map((t) => [`${t.kind}:${t.label}`, t]));

		assert.deepEqual(byKind.get('api:Blocks API')?.dimensions, [
			{ name: 'ApiName', value: 'Blocks API' },
			{ name: 'Stage', value: 'prod' },
		]);
		// v2 is dimensioned by api ID, not name.
		assert.deepEqual(byKind.get('api:f6g7h8i9j0')?.dimensions, [{ name: 'ApiId', value: 'f6g7h8i9j0' }]);
		assert.deepEqual(byKind.get('table:rota-staff')?.dimensions, [
			{ name: 'TableName', value: `${PROD_STACK}-rota-staff` },
		]);
		assert.equal(byKind.get('table:rota-staff')?.namespace, 'AWS/DynamoDB');
		assert.equal(byKind.get('api:f6g7h8i9j0')?.namespace, 'AWS/ApiGateway');
	});

	it('emits no target for a type with no CloudWatch namespace', () => {
		const targets = resourcesToMetricTargets(stackResources(PROD_STACK, 'a1b2c3d4e5', 'f6g7h8i9j0'), {
			stackName: PROD_STACK,
			apiNames: new Map([['a1b2c3d4e5', 'Blocks API']]),
		});
		assert.equal(
			targets.some((t) => t.resourceType === 'AWS::IAM::Role'),
			false,
		);
	});

	it('emits no REST API target when the display name is unresolved', () => {
		// The physical id must NOT stand in for the name: it is not the
		// dimension, so the series would be empty and read as zero traffic.
		const targets = resourcesToMetricTargets(stackResources(PROD_STACK, 'a1b2c3d4e5', 'f6g7h8i9j0'), {
			stackName: PROD_STACK,
		});
		assert.equal(
			targets.some((t) => t.resourceType === 'AWS::ApiGateway::RestApi'),
			false,
		);
		// Every other target still discovered.
		assert.ok(targets.some((t) => t.kind === 'table'));
	});

	it('skips a resource with no physical id', () => {
		const targets = resourcesToMetricTargets([{ LogicalResourceId: 'T', ResourceType: 'AWS::DynamoDB::Table' }]);
		assert.deepEqual(targets, []);
	});

	it('marks the REST API as sharing dimensions, and nothing else', () => {
		const targets = resourcesToMetricTargets(stackResources(PROD_STACK, 'a1b2c3d4e5', 'f6g7h8i9j0'), {
			stackName: PROD_STACK,
			apiNames: new Map([['a1b2c3d4e5', 'Blocks API']]),
			restApiStage: 'prod',
		});
		const shared = targets.filter((t) => t.sharedDimensions);
		assert.equal(shared.length, 1);
		assert.equal(shared[0].resourceType, 'AWS::ApiGateway::RestApi');
		assert.match(shared[0].sharedReason ?? '', /every stage of this app/);
	});

	it('derives the SNS dimension from the topic name, not the ARN', () => {
		const targets = resourcesToMetricTargets(
			[
				{
					LogicalResourceId: 'AlarmTopic',
					ResourceType: 'AWS::SNS::Topic',
					PhysicalResourceId: `arn:aws:sns:eu-west-1:123456789012:${PROD_STACK}-HostingAlarmTopic-3BSmvr0tVoaF`,
				},
			],
			{ stackName: PROD_STACK },
		);
		// The dimension is the full topic name; only the LABEL is shortened.
		assert.deepEqual(targets[0].dimensions, [
			{ name: 'TopicName', value: `${PROD_STACK}-HostingAlarmTopic-3BSmvr0tVoaF` },
		]);
		assert.equal(targets[0].label, 'HostingAlarmTopic-3BSmvr0tVoaF');
	});

	it('keeps the full ARN as the Step Functions dimension but labels it short', () => {
		const arn = `arn:aws:states:eu-west-1:123456789012:stateMachine:BlocksGsiProviderwaiter-h0yj054x8IhS`;
		const targets = resourcesToMetricTargets([
			{ LogicalResourceId: 'Waiter', ResourceType: 'AWS::StepFunctions::StateMachine', PhysicalResourceId: arn },
		]);
		assert.deepEqual(targets[0].dimensions, [{ name: 'StateMachineArn', value: arn }]);
		assert.equal(targets[0].label, 'BlocksGsiProviderwaiter-h0yj054x8IhS');
	});

	it('gives CloudFront its required Global region dimension', () => {
		const targets = resourcesToMetricTargets([
			{
				LogicalResourceId: 'Cdn',
				ResourceType: 'AWS::CloudFront::Distribution',
				PhysicalResourceId: 'E3GGZTOE6OVVS9',
			},
		]);
		assert.deepEqual(targets[0].dimensions, [
			{ name: 'DistributionId', value: 'E3GGZTOE6OVVS9' },
			{ name: 'Region', value: 'Global' },
		]);
	});
});

describe('per-stage separation', () => {
	/*
	 * The reason this page can report per-environment numbers at all, and the
	 * one place it cannot. Both assertions are about REAL values from the two
	 * rota stacks.
	 */
	const prod = discoverMetricTargets(stackResources(PROD_STACK, 'a1b2c3d4e5', 'f6g7h8i9j0'), TEMPLATE, PROD_STACK);
	const sandbox = discoverMetricTargets(
		stackResources(SANDBOX_STACK, 'u1v2w3x4y5', 'z6a7b8c9d0'),
		TEMPLATE,
		SANDBOX_STACK,
	);

	/** The one target of a type, failing the test rather than asserting non-null. */
	function only(targets: MetricTarget[], resourceType: string): MetricTarget {
		const found = targets.filter((t) => t.resourceType === resourceType);
		assert.equal(found.length, 1, `expected exactly one ${resourceType} target`);
		return found[0];
	}

	it('separates tables and functions: no dimension value is shared between stages', () => {
		const keysOf = (targets: MetricTarget[], kind: string) =>
			new Set(targets.filter((t) => t.kind === kind).map(targetKey));
		for (const kind of ['table', 'function']) {
			const overlap = [...keysOf(prod, kind)].filter((key) => keysOf(sandbox, kind).has(key));
			assert.deepEqual(overlap, [], `${kind} dimensions must not be shared between stages`);
		}
	});

	it('separates the websocket api, which is dimensioned by id', () => {
		assert.notEqual(
			targetKey(only(prod, 'AWS::ApiGatewayV2::Api')),
			targetKey(only(sandbox, 'AWS::ApiGatewayV2::Api')),
		);
	});

	it('CANNOT separate the REST api, and says so on the target', () => {
		// Not a bug in this module: the per-stage series does not exist in
		// CloudWatch. Both stacks name the api `Blocks API` on stage `prod`, so
		// one dimension set covers both and CloudWatch sums them. The flag is
		// what lets the view label the figure instead of misreporting it.
		const prodApi = only(prod, 'AWS::ApiGateway::RestApi');
		const sandboxApi = only(sandbox, 'AWS::ApiGateway::RestApi');
		assert.equal(targetKey(prodApi), targetKey(sandboxApi));
		assert.equal(prodApi.sharedDimensions, true);
		assert.equal(sandboxApi.sharedDimensions, true);
	});
});

describe('shortLabel', () => {
	it('strips the stack prefix', () => {
		assert.equal(shortLabel(`${PROD_STACK}-rota-staff`, PROD_STACK), 'rota-staff');
	});

	it('leaves a name that does not carry the prefix alone', () => {
		assert.equal(shortLabel('my-explicit-table', PROD_STACK), 'my-explicit-table');
	});

	it('leaves the name alone when no stack name is known', () => {
		assert.equal(shortLabel(`${PROD_STACK}-rota-staff`), `${PROD_STACK}-rota-staff`);
	});
});

describe('metricRegion', () => {
	it('reads CloudFront from us-east-1 whatever region the stack is in', () => {
		const [cdn] = resourcesToMetricTargets([
			{ LogicalResourceId: 'C', ResourceType: 'AWS::CloudFront::Distribution', PhysicalResourceId: 'E123' },
		]);
		assert.equal(metricRegion(cdn, 'eu-west-1'), 'us-east-1');
	});

	it("reads everything else from the stack's own region", () => {
		const [table] = resourcesToMetricTargets([
			{ LogicalResourceId: 'T', ResourceType: 'AWS::DynamoDB::Table', PhysicalResourceId: 't' },
		]);
		assert.equal(metricRegion(table, 'eu-west-1'), 'eu-west-1');
	});
});

describe('targetKey', () => {
	it('is order-independent across dimensions', () => {
		const [a] = resourcesToMetricTargets(
			[{ LogicalResourceId: 'A', ResourceType: 'AWS::ApiGateway::RestApi', PhysicalResourceId: 'id' }],
			{ apiNames: new Map([['id', 'Blocks API']]), restApiStage: 'prod' },
		);
		const reversed = { ...a, dimensions: [...a.dimensions].reverse() };
		assert.equal(targetKey(a), targetKey(reversed));
	});

	it('distinguishes two resources in the same namespace', () => {
		const targets = resourcesToMetricTargets([
			{ LogicalResourceId: 'A', ResourceType: 'AWS::DynamoDB::Table', PhysicalResourceId: 'table-a' },
			{ LogicalResourceId: 'B', ResourceType: 'AWS::DynamoDB::Table', PhysicalResourceId: 'table-b' },
		]);
		assert.notEqual(targetKey(targets[0]), targetKey(targets[1]));
	});
});

describe('findRestApiStage', () => {
	it('finds the stage physical id', () => {
		assert.equal(findRestApiStage(stackResources(PROD_STACK, 'id', 'ws')), 'prod');
	});

	it('returns undefined when the stack has no REST stage', () => {
		assert.equal(findRestApiStage([{ LogicalResourceId: 'T', ResourceType: 'AWS::DynamoDB::Table' }]), undefined);
	});
});
