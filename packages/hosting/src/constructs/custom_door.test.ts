import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, CfnResource, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { AdapterContext, CapabilityId, CapabilityPlan, SupportTier } from '../plan/types.js';
import { renderCustomDoor } from './custom_door.js';
import type { FrontDoorLayerAdapter, LayerHandle } from './layer.js';

const staticPlan: CapabilityPlan = {
	origins: [{ id: 'blocks-s3', kind: 'static' }],
	routes: { entries: [{ pattern: '/assets/*', kind: 'static' }], redirects: [], headers: [] },
	policies: { spaFallback: true, hasServer: false, skewEnabled: false },
	release: { buildId: 'testbuild' },
};

// A plan that DEMANDS RunServerRender (hasServer → the negotiator requires it).
const ssrPlan: CapabilityPlan = {
	origins: [
		{ id: 'blocks-s3', kind: 'static' },
		{ id: 'blocks-server', kind: 'server' },
	],
	routes: { entries: [{ pattern: '/*', kind: 'server' }], redirects: [], headers: [] },
	policies: { spaFallback: false, hasServer: true, skewEnabled: false },
	release: { buildId: 'testbuild' },
};

// The baseline an SSR-capable door supports as `core`; each test overrides the
// contested capability via the `tiers` ctor arg. (An SSR plan demands
// RunServerRender AND AtomicRelease — the build-id cutover — so both are here.)
const CORE_BASELINE: ReadonlySet<CapabilityId> = new Set<CapabilityId>([
	'RouteRequest',
	'ServeStaticAsset',
	'RunServerRender',
	'AtomicRelease',
]);

/** A minimal customer-authored door: declares tiers, provisions one resource. */
class FakeDoor implements FrontDoorLayerAdapter {
	readonly service = 'fake-edge';
	rendered = false;
	constructor(private readonly tiers: Partial<Record<CapabilityId, SupportTier>> = {}) {}
	supports(cap: CapabilityId): SupportTier {
		if (cap in this.tiers) return this.tiers[cap] as SupportTier;
		return CORE_BASELINE.has(cap) ? 'core' : 'unsupported';
	}
	renderLayer(scope: Construct, _plan: CapabilityPlan, _ctx: AdapterContext): LayerHandle {
		this.rendered = true;
		new CfnResource(scope, 'FakeDoorRes', { type: 'AWS::CloudFormation::WaitConditionHandle' });
		return { url: 'https://fake.example', originHandle: { domainName: 'fake.example', protocol: 'https' } };
	}
}

const stack = () => new Stack(new App(), 'S', { env: { account: '111111111111', region: 'us-west-2' } });

describe('renderCustomDoor', () => {
	it('renders the adapter and returns its handle when every demand is met', () => {
		const door = new FakeDoor();
		const handle = renderCustomDoor(stack(), staticPlan, door, {});
		assert.equal(door.rendered, true);
		assert.equal(handle.url, 'https://fake.example');
		assert.equal(handle.originHandle.domainName, 'fake.example');
	});

	it('fails at synth (does not render) when a demanded capability is unsupported', () => {
		const door = new FakeDoor({ RunServerRender: 'unsupported' });
		assert.throws(
			() => renderCustomDoor(stack(), ssrPlan, door, {}),
			/RunServerRender|cannot serve/,
			'a demanded, unsupported capability must throw at synth',
		);
		assert.equal(door.rendered, false, 'the adapter must not build anything when negotiation fails');
	});

	it('fails when a demanded capability is degraded and NOT accepted via degrade', () => {
		const door = new FakeDoor({ RunServerRender: 'degraded' });
		assert.throws(() => renderCustomDoor(stack(), ssrPlan, door, {}), /RunServerRender|degraded/);
		assert.equal(door.rendered, false);
	});

	it('renders when a degraded capability is explicitly accepted via degrade', () => {
		const door = new FakeDoor({ RunServerRender: 'degraded' });
		const handle = renderCustomDoor(stack(), ssrPlan, door, {}, ['RunServerRender']);
		assert.equal(door.rendered, true);
		assert.equal(handle.url, 'https://fake.example');
	});

	it('renders when the door fully supports the demanded capability', () => {
		const door = new FakeDoor({ RunServerRender: 'core' });
		renderCustomDoor(stack(), ssrPlan, door, {});
		assert.equal(door.rendered, true);
	});
});
