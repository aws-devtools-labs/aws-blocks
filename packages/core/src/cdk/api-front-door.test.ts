// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pieces the `edge` API front door is assembled from.
 *
 * These build real CloudFront configuration and assert the synthesized template
 * rather than the CDK objects: an origin whose host is wrong, or a behavior that
 * caches, is a broken deployment that type-checks perfectly.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Distribution, type IOrigin } from 'aws-cdk-lib/aws-cloudfront';
import {
	API_BEHAVIOR_OPTIONS,
	claimApiFrontDoor,
	httpOriginFromEndpoint,
	resolveApiFrontDoor,
	resolvedApiFrontDoorUrl,
	scheduleApiFrontDoor,
} from './api-front-door.js';

/** A shared gateway URL has the shape `https://{host}/aws-blocks/api` — no stage segment. */
const GATEWAY_URL = 'https://abc123.execute-api.us-east-1.amazonaws.com/aws-blocks/api';

function distributionWith(stack: cdk.Stack, origin: IOrigin): Distribution {
	return new Distribution(stack, 'D', { defaultBehavior: { origin, ...API_BEHAVIOR_OPTIONS } });
}

/** The sole distribution's config, asserting there is exactly one. */
function soleDistributionConfig(stack: cdk.Stack): {
	DefaultCacheBehavior: Record<string, unknown>;
	CacheBehaviors?: Array<{ PathPattern: string; TargetOriginId: string }>;
	Origins: Array<{ DomainName: unknown; OriginPath: unknown }>;
} {
	const distributions = Template.fromStack(stack).findResources('AWS::CloudFront::Distribution');
	assert.strictEqual(Object.keys(distributions).length, 1, 'expected exactly one distribution');
	return Object.values(distributions)[0]?.Properties?.DistributionConfig;
}

describe('httpOriginFromEndpoint', () => {
	test('takes just the host — the shared gateway URL has no stage segment, so no OriginPath', () => {
		// The shared HTTP API v2 `$default` stage serves at the API root, so the
		// origin is the bare host with no `originPath`. A stray OriginPath (a leftover
		// from the old per-compute REST shape) would prefix every forwarded request
		// and 403 at the gateway — invisible until deploy.
		const stack = new cdk.Stack(new cdk.App(), 'S');
		distributionWith(stack, httpOriginFromEndpoint('https://abc123.execute-api.us-east-1.amazonaws.com/aws-blocks/api'));

		const origins = soleDistributionConfig(stack).Origins;
		assert.strictEqual(origins.length, 1);
		assert.strictEqual(origins[0].DomainName, 'abc123.execute-api.us-east-1.amazonaws.com');
		assert.strictEqual(origins[0].OriginPath, undefined, 'no stage segment ⇒ no OriginPath');
	});

	test('splits a tokenized gateway URL through CloudFormation intrinsics', () => {
		// A real gateway URL is a token, so the split has to happen in the template.
		// Doing it in JS would slice the unresolved placeholder text and silently
		// produce a nonsense domain.
		const stack = new cdk.Stack(new cdk.App(), 'S');
		const api = new cdk.aws_apigatewayv2.HttpApi(stack, 'Api');
		const gatewayUrl = `${api.url}aws-blocks/api`;
		distributionWith(stack, httpOriginFromEndpoint(gatewayUrl));

		const origin = soleDistributionConfig(stack).Origins[0];
		assert.ok(JSON.stringify(origin.DomainName).includes('Fn::Select'), 'DomainName should be derived in-template');
		assert.strictEqual(origin.OriginPath, undefined, 'no OriginPath for the shared gateway');
	});
});

describe('API behavior options', () => {
	test('API traffic is uncached, method-complete, HTTPS-only, and forwards all but Host', () => {
		// Every one of these is load-bearing: caching would serve one user's RPC
		// response to another; a narrower method set would 405 raw routes; forwarding
		// Host would make API Gateway reject the request; and viewer HTTP has to
		// upgrade rather than fail.
		const stack = new cdk.Stack(new cdk.App(), 'S');
		distributionWith(stack, httpOriginFromEndpoint(GATEWAY_URL));

		const behavior = soleDistributionConfig(stack).DefaultCacheBehavior;
		// CachingDisabled and AllViewerExceptHostHeader are AWS managed policies with
		// well-known ids; asserting the ids pins the actual behavior, not just that
		// *some* policy was attached.
		const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
		const ALL_VIEWER_EXCEPT_HOST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';
		assert.strictEqual(behavior.CachePolicyId, CACHING_DISABLED);
		assert.strictEqual(behavior.OriginRequestPolicyId, ALL_VIEWER_EXCEPT_HOST);
		assert.strictEqual(behavior.ViewerProtocolPolicy, 'redirect-to-https');
		assert.deepStrictEqual(behavior.AllowedMethods, ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']);
	});
});

describe('scheduleApiFrontDoor', () => {
	test('edge: provisions one distribution with a single catch-all behavior to the gateway origin', () => {
		// Every API path resolves to the shared gateway, so the edge front door is one
		// origin behind one default behavior — no per-path CacheBehaviors.
		const stack = new cdk.Stack(new cdk.App(), 'S');
		scheduleApiFrontDoor(stack, true, GATEWAY_URL);

		const config = soleDistributionConfig(stack);
		assert.ok(config.DefaultCacheBehavior, 'expected a default behavior');
		assert.strictEqual(config.CacheBehaviors, undefined, 'expected no per-path behaviors');
		assert.strictEqual(config.Origins.length, 1, 'expected a single origin');
		assert.strictEqual(config.Origins[0].DomainName, 'abc123.execute-api.us-east-1.amazonaws.com');
		assert.strictEqual(config.Origins[0].OriginPath, undefined, 'the shared gateway origin takes no OriginPath');
	});

	test('edge: records the CloudFront origin as resolvedApiFrontDoorUrl (feeds the ApiUrl output)', () => {
		const stack = new cdk.Stack(new cdk.App(), 'S');
		scheduleApiFrontDoor(stack, true, GATEWAY_URL);
		// Resolve the tree (synth) so the aspect runs.
		Template.fromStack(stack);
		assert.ok(
			resolvedApiFrontDoorUrl(stack)?.startsWith('https://'),
			'resolved URL should be the CloudFront https origin',
		);
		assert.ok(
			!resolvedApiFrontDoorUrl(stack)?.includes('execute-api'),
			'resolved URL should be the CloudFront domain, not the raw gateway',
		);
	});

	test('regional: provisions nothing when the tier opts out', () => {
		const stack = new cdk.Stack(new cdk.App(), 'S');
		scheduleApiFrontDoor(stack, false, GATEWAY_URL);
		Template.fromStack(stack).resourceCountIs('AWS::CloudFront::Distribution', 0);
		assert.strictEqual(resolvedApiFrontDoorUrl(stack), undefined, 'no front door ⇒ no resolved URL');
	});

	test('provisions nothing without a gateway URL to forward to', () => {
		// No origin means there is nothing coherent to put behind the default behavior.
		const stack = new cdk.Stack(new cdk.App(), 'S');
		scheduleApiFrontDoor(stack, true, undefined);
		Template.fromStack(stack).resourceCountIs('AWS::CloudFront::Distribution', 0);
	});

	test('stands down when a Hosting distribution has claimed the front-door role', () => {
		// A Hosting that fronts the API publishes its own origin; the managed edge
		// distribution must not add a second one that doubles hops and splits the domain.
		// The claim rides on the owner instance (not per-stack state), so the aspect
		// scheduled on that same owner sees it — the mechanism that works cross-stack.
		const stack = new cdk.Stack(new cdk.App(), 'S');
		claimApiFrontDoor(stack, 'https://d111.cloudfront.net');
		scheduleApiFrontDoor(stack, true, GATEWAY_URL);
		Template.fromStack(stack).resourceCountIs('AWS::CloudFront::Distribution', 0);
		assert.strictEqual(resolvedApiFrontDoorUrl(stack), 'https://d111.cloudfront.net', 'claim URL stands');
	});

	test('builds the front door once, not once per construct visited', () => {
		// The aspect is invoked for every construct in the stack; without the one-shot
		// guard it would emit a distribution per node and fail on a duplicate output.
		const stack = new cdk.Stack(new cdk.App(), 'S');
		new cdk.aws_sns.Topic(stack, 'T1');
		new cdk.aws_sns.Topic(stack, 'T2');
		scheduleApiFrontDoor(stack, true, GATEWAY_URL);
		Template.fromStack(stack).resourceCountIs('AWS::CloudFront::Distribution', 1);
	});
});

describe('resolveApiFrontDoor', () => {
	test('the app’s explicit choice is honored, in both directions', () => {
		assert.strictEqual(resolveApiFrontDoor('edge'), 'edge');
		assert.strictEqual(resolveApiFrontDoor('regional'), 'regional');
	});

	test('defaults to the constant regional tier when the app expresses no preference', () => {
		assert.strictEqual(resolveApiFrontDoor(undefined), 'regional');
	});
});
