// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for getOrCreateOtelSharedInfra.
 *
 * Verifies idempotent attachment of the collector + config layers to the shared
 * handler, the collector-config env var (and absence of an exec wrapper), additive
 * per-signal IAM grants, and the dedicated CloudWatch Logs group/stream.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { getOrCreateOtelSharedInfra } from './cdk.js';

class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly id: string;
	constructor(scope: Construct, id: string) {
		super(scope, id, { env: { account: '111122223333', region: 'us-east-1' } });
		this.id = id;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
		});
	}
}

function setup(): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'TestStack');
	const parent = new Scope('app');
	return { stack, parent };
}

function policyActions(template: Template): string[] {
	const policies = template.findResources('AWS::IAM::Policy');
	const actions: string[] = [];
	for (const id of Object.keys(policies)) {
		const stmts = policies[id]?.Properties?.PolicyDocument?.Statement;
		if (!Array.isArray(stmts)) continue;
		for (const s of stmts) {
			const a = s.Action;
			if (Array.isArray(a)) actions.push(...a);
			else if (typeof a === 'string') actions.push(a);
		}
	}
	return actions;
}

describe('getOrCreateOtelSharedInfra', () => {
	test('attaches exactly two layers (collector + config) regardless of call count', () => {
		const { stack, parent } = setup();
		getOrCreateOtelSharedInfra(stack, stack.handler, parent, { signals: { metrics: true, traces: false, logs: false } });
		getOrCreateOtelSharedInfra(stack, stack.handler, parent, { signals: { traces: true, metrics: false, logs: false } });
		getOrCreateOtelSharedInfra(stack, stack.handler, parent, { signals: { logs: true, metrics: false, traces: false } });

		const template = Template.fromStack(stack);
		// One imported collector layer (fromLayerVersionArn → not a CFN resource) +
		// one config LayerVersion we create. Assert the created config layer count == 1.
		const layers = template.findResources('AWS::Lambda::LayerVersion');
		assert.strictEqual(Object.keys(layers).length, 1, 'exactly one config LayerVersion created');

		// The shared handler should reference two layers (collector ARN + config layer).
		const fns = template.findResources('AWS::Lambda::Function');
		const handler = Object.values(fns).find(
			(f: any) => Array.isArray(f.Properties?.Layers) && f.Properties.Layers.length > 0,
		) as any;
		assert.ok(handler, 'handler has layers');
		assert.strictEqual(handler.Properties.Layers.length, 2, 'collector + config layers');
	});

	test('sets the collector-config env var and NO exec wrapper', () => {
		const { stack, parent } = setup();
		getOrCreateOtelSharedInfra(stack, stack.handler, parent, {});
		const template = Template.fromStack(stack);
		const fns = template.findResources('AWS::Lambda::Function');
		const env = (Object.values(fns).find((f: any) => f.Properties?.Environment) as any)
			?.Properties?.Environment?.Variables ?? {};
		assert.strictEqual(env.OPENTELEMETRY_COLLECTOR_CONFIG_URI, '/opt/collector.yaml');
		assert.strictEqual(env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED, 'false');
		assert.ok(!('AWS_LAMBDA_EXEC_WRAPPER' in env), 'no exec wrapper');
	});

	test('grants metrics IAM (cloudwatch:PutMetricData) for the metrics signal', () => {
		const { stack, parent } = setup();
		getOrCreateOtelSharedInfra(stack, stack.handler, parent, { signals: { metrics: true, traces: false, logs: false } });
		const actions = policyActions(Template.fromStack(stack));
		assert.ok(actions.includes('cloudwatch:PutMetricData'));
		assert.ok(!actions.includes('xray:PutSpans'), 'no trace grant when traces disabled');
	});

	test('a single requested signal grants ONLY that signal (least privilege)', () => {
		// Regression: signals default OFF, so `{ metrics: true }` must NOT also grant
		// xray/logs. (A bug where defaults were ON over-granted every block.)
		const { stack, parent } = setup();
		getOrCreateOtelSharedInfra(stack, stack.handler, parent, { signals: { metrics: true } });
		const actions = policyActions(Template.fromStack(stack));
		assert.deepStrictEqual(actions.filter(a => /cloudwatch|xray|logs/.test(a)).sort(), ['cloudwatch:PutMetricData']);
		Template.fromStack(stack).resourceCountIs('AWS::Logs::LogGroup', 0);
	});

	test('grants accumulate additively across blocks (metrics + traces + logs)', () => {
		const { stack, parent } = setup();
		getOrCreateOtelSharedInfra(stack, stack.handler, parent, { signals: { metrics: true } });
		getOrCreateOtelSharedInfra(stack, stack.handler, parent, { signals: { traces: true } });
		getOrCreateOtelSharedInfra(stack, stack.handler, parent, { signals: { logs: true } });
		const actions = policyActions(Template.fromStack(stack));
		assert.ok(actions.includes('cloudwatch:PutMetricData'));
		assert.ok(actions.includes('xray:PutSpans'));
		assert.ok(actions.includes('logs:PutLogEvents'));
		// Still exactly one collector config layer + one log group.
		const t = Template.fromStack(stack);
		assert.strictEqual(Object.keys(t.findResources('AWS::Lambda::LayerVersion')).length, 1);
		t.resourceCountIs('AWS::Logs::LogGroup', 1);
	});

	test('grants the X-Ray OTLP actions for the traces signal', () => {
		const { stack, parent } = setup();
		getOrCreateOtelSharedInfra(stack, stack.handler, parent, { signals: { traces: true, metrics: false, logs: false } });
		const actions = policyActions(Template.fromStack(stack));
		assert.ok(actions.includes('xray:PutSpans'));
		assert.ok(actions.includes('xray:PutSpansForIndexing'));
		assert.ok(actions.includes('xray:PutTraceSegments'));
	});

	test('creates a dedicated log group + stream and grants logs IAM for the logs signal', () => {
		const { stack, parent } = setup();
		getOrCreateOtelSharedInfra(stack, stack.handler, parent, { signals: { logs: true, metrics: false, traces: false } });
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::Logs::LogGroup', 1);
		template.resourceCountIs('AWS::Logs::LogStream', 1);
		// Default group name is /aws/otel/<scope.fullId>; fullId includes the stack name.
		template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/aws/otel/TestStack-app' });
		const actions = policyActions(template);
		assert.ok(actions.includes('logs:PutLogEvents'));
		assert.ok(actions.includes('logs:DescribeLogStreams'));
	});

	test('does NOT create a duplicate log group when logs requested twice', () => {
		const { stack, parent } = setup();
		getOrCreateOtelSharedInfra(stack, stack.handler, parent, { signals: { logs: true, metrics: false, traces: false } });
		getOrCreateOtelSharedInfra(stack, stack.handler, parent, { signals: { logs: true, metrics: false, traces: false } });
		Template.fromStack(stack).resourceCountIs('AWS::Logs::LogGroup', 1);
	});

	test('endpoint override attaches no AWS IAM grants', () => {
		const { stack, parent } = setup();
		getOrCreateOtelSharedInfra(stack, stack.handler, parent, {
			endpointOverride: { endpoint: 'https://otlp.example.com', headers: { 'x-api-key': 'k' } },
		});
		const actions = policyActions(Template.fromStack(stack));
		assert.ok(!actions.includes('cloudwatch:PutMetricData'));
		assert.ok(!actions.includes('xray:PutSpans'));
	});
});
