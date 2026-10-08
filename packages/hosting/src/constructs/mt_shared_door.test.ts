import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { CapabilityPlan } from '../plan/types.js';
import { renderCustomDoor } from './custom_door.js';
import { SharedAlbDoor, SharedApiGatewayDoor, SharedCloudFrontDoor } from './mt_shared_door.js';

const plan = (buildId: string, extra: Partial<CapabilityPlan> = {}): CapabilityPlan => ({
	origins: [{ id: 'blocks-s3', kind: 'static' }],
	routes: { entries: [{ pattern: '/*', kind: 'static' }], redirects: [], headers: [] },
	policies: { spaFallback: true, hasServer: false, skewEnabled: false },
	release: { buildId },
	...extra,
});
const withApi = (buildId: string, url: string): CapabilityPlan =>
	plan(buildId, { backend: { origins: [{ namespace: '*', ingress: { kind: 'url', url } }] } });

const stack = () => new Stack(new App(), 'Mt', { env: { account: '111111111111', region: 'us-west-2' } });

describe('SharedCloudFrontDoor — one distribution, N tenant apps (hooks)', () => {
	it('registers each tenant in ONE distribution’s router and grants OAC read per tenant bucket', () => {
		const s = stack();
		const shared = new SharedCloudFrontDoor(s, 'Shared');
		const a = renderCustomDoor(s, withApi('ba', 'https://a.example.com/aws-blocks'), shared.forTenant('tenant-a'), {
			bucket: new Bucket(s, 'BucketA'),
		});
		const b = renderCustomDoor(s, plan('bb'), shared.forTenant('tenant-b'), { bucket: new Bucket(s, 'BucketB') });
		const t = Template.fromStack(s);
		t.resourceCountIs('AWS::CloudFront::Distribution', 1);
		t.resourceCountIs('AWS::CloudFront::Function', 1);
		const json = JSON.stringify(t.toJSON());
		for (const needle of ['tenant-a', 'tenant-b', 'builds/ba', 'builds/bb', 'a.example.com']) {
			assert.ok(json.includes(needle), `router table should include ${needle}`);
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
		const h = renderCustomDoor(s, plan('b1'), shared.forTenant('tenant-a'), { bucket: new Bucket(s, 'B') });
		assert.equal(h.url, 'https://tenant-a.app.example.com/');
	});

	it('rejects a duplicate or malformed tenant id (isolation check in `create`)', () => {
		const s = stack();
		const shared = new SharedCloudFrontDoor(s, 'Shared');
		renderCustomDoor(s, plan('b1'), shared.forTenant('tenant-a'), { bucket: new Bucket(s, 'B1') });
		assert.throws(
			() => renderCustomDoor(s, plan('b2'), shared.forTenant('tenant-a'), { bucket: new Bucket(s, 'B2') }),
			/already registered/,
		);
		assert.throws(
			() => renderCustomDoor(s, plan('b3'), shared.forTenant('Tenant_A'), { bucket: new Bucket(s, 'B3') }),
			/Invalid tenantId/,
		);
	});

	it('fails at synth when a tenant demands what the shared door has no hook / report for', () => {
		const s = stack();
		const shared = new SharedCloudFrontDoor(s, 'Shared');
		const ssr = plan('b1', {
			origins: [
				{ id: 'blocks-s3', kind: 'static' },
				{ id: 'blocks-server', kind: 'server' },
			],
			policies: { spaFallback: false, hasServer: true, skewEnabled: false },
		});
		assert.throws(
			() => renderCustomDoor(s, ssr, shared.forTenant('ssr-app'), { bucket: new Bucket(s, 'B1') }),
			/RunServerRender/,
		);
		const waf = plan('b2', { policies: { spaFallback: true, hasServer: false, skewEnabled: false, wafEnabled: true } });
		assert.throws(
			() => renderCustomDoor(s, waf, shared.forTenant('waf-app'), { bucket: new Bucket(s, 'B2') }),
			/FilterRequests/,
		);
	});
});

describe('SharedApiGatewayDoor / SharedAlbDoor — one router Lambda, N tenant apps', () => {
	it('api gateway: one HTTP API; the router env carries every tenant + its API base; IAM read per bucket', () => {
		const s = stack();
		const shared = new SharedApiGatewayDoor(s, 'Shared');
		renderCustomDoor(s, withApi('ba', 'https://a.example.com/aws-blocks'), shared.forTenant('tenant-a'), {
			bucket: new Bucket(s, 'BucketA'),
		});
		renderCustomDoor(s, plan('bb'), shared.forTenant('tenant-b'), { bucket: new Bucket(s, 'BucketB') });
		const t = Template.fromStack(s);
		t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
		const routers = Object.values(t.findResources('AWS::Lambda::Function')).filter((f) =>
			JSON.stringify(f).includes('TENANT_ROUTES'),
		);
		assert.equal(routers.length, 1);
		const env = JSON.stringify(routers[0]);
		for (const needle of ['tenant-a', 'tenant-b', 'builds/ba', 'a.example.com']) assert.ok(env.includes(needle), needle);
	});

	it('alb: one ALB + one listener + one Lambda target group for every tenant', () => {
		const s = stack();
		const vpc = new ec2.Vpc(s, 'Vpc', { maxAzs: 2, natGateways: 0 });
		const shared = new SharedAlbDoor(s, 'Shared', { vpc });
		for (const id of ['tenant-a', 'tenant-b', 'tenant-c']) {
			const h = renderCustomDoor(s, plan(`b-${id}`), shared.forTenant(id), { bucket: new Bucket(s, `B-${id}`) });
			assert.match(String(h.url), new RegExp(`^http://.*/${id}/$`));
		}
		const t = Template.fromStack(s);
		t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
		t.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
		t.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 0);
		t.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
	});
});
