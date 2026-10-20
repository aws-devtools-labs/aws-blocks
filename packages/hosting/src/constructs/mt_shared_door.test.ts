// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Function as LambdaFunction, Code, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { buildFrontDoor } from './custom_door.js';
import { BLOCKS_API_SUBTREE } from './door_input.js';
import type { DoorFeatures, DoorInput, FrontDoor } from './front_door.js';
import { SharedAlbDoor, SharedApiGatewayDoor, SharedCloudFrontDoor } from './mt_shared_door.js';

type InputOptions = { apiUrl?: string; server?: boolean; features?: DoorFeatures };

/** A tenant app's DoorInput: its own bucket at `builds/<buildId>/`, optionally an API. */
const tenantInput = (scope: Construct, id: string, buildId: string, opts: InputOptions = {}): DoorInput => {
	const assets = {
		kind: 'assets' as const,
		bucket: new Bucket(scope, `${id}Bucket`),
		prefix: `builds/${buildId}/`,
		sourceDir: '.',
	};
	const serverFn = opts.server
		? new LambdaFunction(scope, `${id}Server`, {
				runtime: Runtime.NODEJS_22_X,
				handler: 'index.handler',
				code: Code.fromInline('exports.handler = async () => ({})'),
			})
		: undefined;
	return {
		app: { buildId, spaFallback: true, routes: [{ pattern: '/*', origin: assets }], redirects: [], headers: [] },
		origins: {
			assets,
			...(serverFn
				? { server: { kind: 'server' as const, fn: serverFn, url: serverFn.addFunctionUrl(), streaming: false } }
				: {}),
			...(opts.apiUrl
				? {
						api: {
							kind: 'api' as const,
							url: opts.apiUrl,
							host: new URL(opts.apiUrl).host,
							stagePath: '/prod',
							paths: [BLOCKS_API_SUBTREE],
						},
					}
				: {}),
		},
		features: opts.features ?? {},
	};
};

const build = (scope: Construct, door: FrontDoor, input: DoorInput) => buildFrontDoor(scope, door, input).result;

const stack = () => new Stack(new App(), 'Mt', { env: { account: '111111111111', region: 'us-west-2' } });

describe('SharedCloudFrontDoor — one distribution, N tenant apps', () => {
	it('registers each tenant in ONE distribution’s router and grants OAC read per tenant bucket', () => {
		const s = stack();
		const shared = new SharedCloudFrontDoor(s, 'Shared');
		const a = build(
			s,
			shared.forTenant('tenant-a'),
			tenantInput(s, 'A', 'ba', { apiUrl: 'https://a.example.com/prod/aws-blocks' }),
		);
		const b = build(s, shared.forTenant('tenant-b'), tenantInput(s, 'B', 'bb'));
		const t = Template.fromStack(s);
		t.resourceCountIs('AWS::CloudFront::Distribution', 1);
		t.resourceCountIs('AWS::CloudFront::Function', 1);
		const json = JSON.stringify(t.toJSON());
		for (const needle of ['tenant-a', 'tenant-b', 'builds/ba"', 'builds/bb"', 'https://a.example.com/prod"']) {
			assert.ok(json.includes(needle.replace(/"/g, '\\"')), `router table should include ${needle}`);
		}
		// One OAC grant per tenant bucket (scoped to the shared distribution).
		const policies = Object.values(t.findResources('AWS::S3::BucketPolicy')).filter((p) =>
			JSON.stringify(p).includes('cloudfront.amazonaws.com'),
		);
		assert.ok(policies.length >= 2, 'each tenant bucket grants the shared distribution');
		assert.deepEqual(shared.tenantIds, ['tenant-a', 'tenant-b']);
		assert.match(String(a.url), /\/tenant-a\/$/);
		assert.match(String(b.url), /\/tenant-b\/$/);
	});

	it('subdomain routing reports `<tenant>.<domain>` URLs and needs a domain', () => {
		const s = stack();
		assert.throws(() => new SharedCloudFrontDoor(s, 'NoDomain', { routing: 'subdomain' }), /needs `domain`/);
		const shared = new SharedCloudFrontDoor(s, 'Sub', { routing: 'subdomain', domain: 'app.example.com' });
		const h = build(s, shared.forTenant('tenant-a'), tenantInput(s, 'A', 'b1'));
		assert.equal(h.url, 'https://tenant-a.app.example.com/');
	});

	it('rejects a duplicate or malformed tenant id', () => {
		const s = stack();
		const shared = new SharedCloudFrontDoor(s, 'Shared');
		build(s, shared.forTenant('tenant-a'), tenantInput(s, 'A1', 'b1'));
		assert.throws(() => build(s, shared.forTenant('tenant-a'), tenantInput(s, 'A2', 'b2')), /already registered/);
		assert.throws(() => build(s, shared.forTenant('Tenant_A'), tenantInput(s, 'A3', 'b3')), /Invalid tenantId/);
	});

	it('fails at synth for a tenant it cannot serve: server rendering, or a per-tenant door feature', () => {
		const s = stack();
		const shared = new SharedCloudFrontDoor(s, 'Shared');
		assert.throws(
			() => build(s, shared.forTenant('ssr-app'), tenantInput(s, 'Ssr', 'b1', { server: true })),
			/server rendering/,
		);
		assert.throws(
			() => build(s, shared.forTenant('waf-app'), tenantInput(s, 'Waf', 'b2', { features: { waf: { enabled: true } } })),
			/features\.waf/,
		);
		// Skew protection is on by default for every app — it must not block a tenant.
		build(
			s,
			shared.forTenant('skew-app'),
			tenantInput(s, 'Skew', 'b3', { features: { skewProtection: { enabled: true, maxAge: 60 } } }),
		);
		assert.deepEqual(shared.tenantIds, ['skew-app']);
	});
});

describe('SharedApiGatewayDoor / SharedAlbDoor — one router Lambda, N tenant apps', () => {
	it('api gateway: one HTTP API; the router env carries every tenant + its API base; IAM read per bucket', () => {
		const s = stack();
		const shared = new SharedApiGatewayDoor(s, 'Shared');
		build(s, shared.forTenant('tenant-a'), tenantInput(s, 'A', 'ba', { apiUrl: 'https://a.example.com/aws-blocks' }));
		build(s, shared.forTenant('tenant-b'), tenantInput(s, 'B', 'bb'));
		const t = Template.fromStack(s);
		t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
		const routers = Object.values(t.findResources('AWS::Lambda::Function')).filter((f) =>
			JSON.stringify(f).includes('TENANT_ROUTES'),
		);
		assert.equal(routers.length, 1);
		const env = JSON.stringify(routers[0]);
		for (const needle of ['tenant-a', 'tenant-b', 'builds/ba', 'https://a.example.com']) {
			assert.ok(env.includes(needle), needle);
		}
		assert.ok(!env.includes('a.example.com/aws-blocks'), 'the API base drops the /aws-blocks suffix');
	});

	it('alb: one ALB + one listener + one Lambda target group for every tenant', () => {
		const s = stack();
		const vpc = new ec2.Vpc(s, 'Vpc', { maxAzs: 2, natGateways: 0 });
		const shared = new SharedAlbDoor(s, 'Shared', { vpc });
		for (const id of ['tenant-a', 'tenant-b', 'tenant-c']) {
			const h = build(s, shared.forTenant(id), tenantInput(s, id, `b-${id}`));
			assert.match(String(h.url), new RegExp(`^http://.*/${id}/$`));
		}
		const t = Template.fromStack(s);
		t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
		t.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
		t.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 0);
		t.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
	});
});
