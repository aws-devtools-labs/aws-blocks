// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pieces the API front door is assembled from.
 *
 * These build real CloudFront configuration and assert the synthesized template
 * rather than the CDK objects: an origin whose `OriginPath` is wrong, or a
 * behavior that caches, is a broken deployment that type-checks perfectly.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Distribution, type IOrigin } from 'aws-cdk-lib/aws-cloudfront';
import {
	addRouteBehaviors,
	API_BEHAVIOR_OPTIONS,
	httpOriginFromEndpoint,
	resolveApiFrontDoor,
	scheduleApiFrontDoor,
} from './api-front-door.js';
import { clearRouteRegistry, getRegisteredRoutes, registerRoute, registerRoutingEntry } from '../raw-route.js';

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
	test('splits host from stage, putting the stage on OriginPath', () => {
		// The endpoint is one string but CloudFront needs two fields: the domain to
		// connect to, and a path prefix to prepend to every forwarded request. Getting
		// the second wrong is the difference between a working API and a 403 from API
		// Gateway, and it is invisible until deploy.
		const stack = new cdk.Stack(new cdk.App(), 'S');
		distributionWith(stack, httpOriginFromEndpoint('https://abc123.execute-api.us-east-1.amazonaws.com/prod'));

		const distributions = Template.fromStack(stack).findResources('AWS::CloudFront::Distribution');
		const origins = Object.values(distributions)[0]?.Properties?.DistributionConfig?.Origins;
		assert.strictEqual(origins.length, 1);
		assert.strictEqual(origins[0].DomainName, 'abc123.execute-api.us-east-1.amazonaws.com');
		assert.strictEqual(origins[0].OriginPath, '/prod');
	});

	test('splits a tokenized endpoint through CloudFormation intrinsics', () => {
		// A real endpoint is a token, so the split has to happen in the template. Doing
		// it in JS would slice the unresolved placeholder text and silently produce a
		// nonsense domain.
		const stack = new cdk.Stack(new cdk.App(), 'S');
		const api = new cdk.aws_apigateway.RestApi(stack, 'Api');
		api.root.addMethod('GET');
		const endpoint =
			`https://${api.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}/` +
			api.deploymentStage.stageName;
		distributionWith(stack, httpOriginFromEndpoint(endpoint));

		const distributions = Template.fromStack(stack).findResources('AWS::CloudFront::Distribution');
		const origin = Object.values(distributions)[0]?.Properties?.DistributionConfig?.Origins[0];
		// Both fields resolve through Fn::Select/Fn::Split rather than being baked in.
		assert.ok(JSON.stringify(origin.DomainName).includes('Fn::Select'), 'DomainName should be derived in-template');
		assert.ok(JSON.stringify(origin.OriginPath).includes('Fn::Select'), 'OriginPath should be derived in-template');
	});
});

describe('API behavior options', () => {
	test('API traffic is uncached, method-complete, HTTPS-only, and forwards all but Host', () => {
		// Every one of these is load-bearing: caching would serve one user's RPC
		// response to another; a narrower method set would 405 raw routes; forwarding
		// Host would make API Gateway reject the request; and viewer HTTP has to
		// upgrade rather than fail.
		const stack = new cdk.Stack(new cdk.App(), 'S');
		distributionWith(stack, httpOriginFromEndpoint('https://abc.execute-api.us-east-1.amazonaws.com/prod'));

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
	const ENDPOINT = 'https://abc.execute-api.us-east-1.amazonaws.com/prod';

	test('provisions one distribution: the reserved RPC/auth behaviors, all on the default origin', () => {
		// Every API path resolves to the default compute today, so the managed front
		// door emits the reserved RPC/auth catch-alls — redundant with the default
		// behavior and inert — all pointing at the one default origin.
		clearRouteRegistry();
		const stack = new cdk.Stack(new cdk.App(), 'S');
		scheduleApiFrontDoor(stack, true, ENDPOINT);

		const config = soleDistributionConfig(stack);
		assert.ok(config.DefaultCacheBehavior, 'expected a default behavior');
		const patterns = (config.CacheBehaviors ?? []).map((b) => b.PathPattern);
		assert.deepStrictEqual(patterns, ['/aws-blocks/api', '/aws-blocks/api/*', '/aws-blocks/auth/*']);
		assert.strictEqual(config.Origins.length, 1, 'all behaviors on the single default origin');
		clearRouteRegistry();
	});

	test('provisions nothing when the posture opts out', () => {
		const stack = new cdk.Stack(new cdk.App(), 'S');
		scheduleApiFrontDoor(stack, false, ENDPOINT);
		Template.fromStack(stack).resourceCountIs('AWS::CloudFront::Distribution', 0);
	});

	test('provisions nothing without a default endpoint to forward to', () => {
		// A worker-only default compute has no HTTP origin, so there is nothing
		// coherent to put behind the default behavior.
		const stack = new cdk.Stack(new cdk.App(), 'S');
		scheduleApiFrontDoor(stack, true, undefined);
		Template.fromStack(stack).resourceCountIs('AWS::CloudFront::Distribution', 0);
	});

	test('builds the front door once, not once per construct visited', () => {
		// The aspect is invoked for every construct in the stack; without the one-shot
		// guard it would emit a distribution per node and fail on a duplicate output.
		const stack = new cdk.Stack(new cdk.App(), 'S');
		new cdk.aws_sns.Topic(stack, 'T1');
		new cdk.aws_sns.Topic(stack, 'T2');
		scheduleApiFrontDoor(stack, true, ENDPOINT);
		Template.fromStack(stack).resourceCountIs('AWS::CloudFront::Distribution', 1);
	});
});

describe('addRouteBehaviors', () => {
	const DEFAULT = 'https://default.execute-api.us-east-1.amazonaws.com/prod';
	const OTHER = 'https://other.execute-api.us-east-1.amazonaws.com/prod';

	/** A distribution whose default behavior points at `origin` (the caller-owned one). */
	function seedDistribution(stack: cdk.Stack): { dist: Distribution; origin: IOrigin } {
		const origin = httpOriginFromEndpoint(DEFAULT);
		return { dist: distributionWith(stack, origin), origin };
	}

	test('a default-endpoint namespace still gets a (redundant) behavior, plus the reserved fallbacks', () => {
		// No mode flag: every API path gets an explicit behavior. A default-endpoint
		// namespace's behaviors are redundant with the reserved RPC catch-all (all
		// point at the one default origin) but inert — that redundancy is what lets
		// one code path serve both distributions.
		clearRouteRegistry();
		registerRoutingEntry({ path: '/aws-blocks/api/notes', endpoint: DEFAULT, subtree: true });
		const stack = new cdk.Stack(new cdk.App(), 'S');
		const { dist, origin } = seedDistribution(stack);
		addRouteBehaviors(dist, getRegisteredRoutes(), DEFAULT, new Map([[DEFAULT, origin]]));

		const config = soleDistributionConfig(stack);
		const patterns = (config.CacheBehaviors ?? []).map((b) => b.PathPattern);
		assert.deepStrictEqual(patterns, [
			'/aws-blocks/api/notes',
			'/aws-blocks/api/notes/*',
			'/aws-blocks/api',
			'/aws-blocks/api/*',
			'/aws-blocks/auth/*',
		]);
		assert.strictEqual(config.Origins.length, 1, 'everything on the default origin → one origin');
		clearRouteRegistry();
	});

	test('a non-default namespace fans out to its compute origin, before the reserved fallbacks', () => {
		// The assignment surface (a later PR) flips this namespace's endpoint; the same
		// registration then carries a non-default endpoint and this code fans it out —
		// the exact/subtree pair — to a second origin, ahead of the RPC catch-all so it
		// wins first-match.
		clearRouteRegistry();
		registerRoutingEntry({ path: '/aws-blocks/api/heavy', endpoint: OTHER, subtree: true });
		const stack = new cdk.Stack(new cdk.App(), 'S');
		const { dist, origin } = seedDistribution(stack);
		addRouteBehaviors(dist, getRegisteredRoutes(), DEFAULT, new Map([[DEFAULT, origin]]));

		const config = soleDistributionConfig(stack);
		const patterns = (config.CacheBehaviors ?? []).map((b) => b.PathPattern);
		assert.deepStrictEqual(patterns, [
			'/aws-blocks/api/heavy',
			'/aws-blocks/api/heavy/*',
			'/aws-blocks/api',
			'/aws-blocks/api/*',
			'/aws-blocks/auth/*',
		]);
		assert.strictEqual(config.Origins.length, 2, 'default origin plus the assigned compute origin');
		clearRouteRegistry();
	});

	test('a RawRoute gets a behavior, and the reserved fallbacks come last', () => {
		// A RawRoute is diverted like any other API path; the reserved RPC/auth
		// catch-alls are added last so a per-namespace behavior would win first-match.
		clearRouteRegistry();
		registerRoute({ method: 'GET', path: '/health', handler: async () => {}, endpoint: DEFAULT });
		const stack = new cdk.Stack(new cdk.App(), 'S');
		const { dist, origin } = seedDistribution(stack);
		addRouteBehaviors(dist, getRegisteredRoutes(), DEFAULT, new Map([[DEFAULT, origin]]));

		const patterns = (soleDistributionConfig(stack).CacheBehaviors ?? []).map((b) => b.PathPattern);
		assert.ok(patterns.includes('/health'), 'RawRoute gets a behavior');
		assert.ok(patterns.includes('/aws-blocks/api'), 'bare RPC path covered');
		assert.ok(patterns.includes('/aws-blocks/api/*'), 'RPC subtree covered');
		assert.ok(patterns.includes('/aws-blocks/auth/*'), 'auth subtree covered');
		// The reserved fallbacks come last so a per-namespace behavior would win first-match.
		assert.strictEqual(patterns[patterns.length - 1], '/aws-blocks/auth/*');
		clearRouteRegistry();
	});
});

describe('resolveApiFrontDoor', () => {
	test('the app’s explicit choice overrides the posture, in both directions', () => {
		assert.strictEqual(resolveApiFrontDoor('cloudfront', { provisionApiFrontDoor: false }), true);
		assert.strictEqual(resolveApiFrontDoor('none', { provisionApiFrontDoor: true }), false);
	});

	test('the posture decides when the app expresses no preference', () => {
		assert.strictEqual(resolveApiFrontDoor(undefined, { provisionApiFrontDoor: true }), true);
		assert.strictEqual(resolveApiFrontDoor(undefined, { provisionApiFrontDoor: false }), false);
	});
});
