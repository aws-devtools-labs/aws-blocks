import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, CfnResource, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { AdapterContext, CapabilityId, CapabilityPlan, SupportTier } from '../plan/types.js';
import { assertAdapterConformance } from './conformance.js';
import type { FrontDoorLayerAdapter, LayerHandle } from './layer.js';

/** A conforming door: total `supports`, serves static, returns a well-formed handle. */
class GoodDoor implements FrontDoorLayerAdapter {
	readonly service = 'good-edge';
	supports(cap: CapabilityId): SupportTier {
		return cap === 'RouteRequest' || cap === 'ServeStaticAsset' ? 'core' : 'unsupported';
	}
	renderLayer(scope: Construct, _plan: CapabilityPlan, _ctx: AdapterContext): LayerHandle {
		new CfnResource(scope, 'GoodDoorRes', { type: 'AWS::CloudFormation::WaitConditionHandle' });
		return { url: 'https://good.example', originHandle: { domainName: 'good.example', protocol: 'https' } };
	}
}

const freshScope = () => new Stack(new App(), 'S', { env: { account: '111111111111', region: 'us-east-1' } });

describe('assertAdapterConformance', () => {
	it('passes for a well-formed adapter', () => {
		assert.doesNotThrow(() => assertAdapterConformance(new GoodDoor(), { scope: freshScope() }));
	});

	it('fails when `service` is missing', () => {
		const door = new GoodDoor();
		(door as { service: string }).service = '';
		assert.throws(() => assertAdapterConformance(door, { scope: freshScope() }), /service/);
	});

	it('fails when supports() is not total (throws for some capability)', () => {
		const door = new GoodDoor();
		door.supports = (cap: CapabilityId) => {
			if (cap === 'Alarms') throw new Error('forgot this one');
			return 'unsupported';
		};
		assert.throws(() => assertAdapterConformance(door, { scope: freshScope() }), /Alarms|total/);
	});

	it('fails when supports() returns an invalid tier', () => {
		const door = new GoodDoor();
		door.supports = () => 'maybe' as SupportTier;
		assert.throws(() => assertAdapterConformance(door, { scope: freshScope() }), /expected 'core'/);
	});

	it('fails when the adapter cannot serve the baseline static plan', () => {
		const door = new GoodDoor();
		door.supports = () => 'unsupported'; // cannot even route/serve static
		assert.throws(
			() => assertAdapterConformance(door, { scope: freshScope() }),
			/does not serve|ServeStaticAsset|RouteRequest/,
		);
	});

	it('fails when renderLayer returns a handle without a usable originHandle', () => {
		class NoHandleDoor extends GoodDoor {
			override renderLayer(scope: Construct): LayerHandle {
				new CfnResource(scope, 'R', { type: 'AWS::CloudFormation::WaitConditionHandle' });
				return { url: 'https://x.example', originHandle: { domainName: '', protocol: 'https' } };
			}
		}
		assert.throws(() => assertAdapterConformance(new NoHandleDoor(), { scope: freshScope() }), /domainName/);
	});

	it('fails when renderLayer omits the public url on the root layer', () => {
		class NoUrlDoor extends GoodDoor {
			override renderLayer(scope: Construct): LayerHandle {
				new CfnResource(scope, 'R', { type: 'AWS::CloudFormation::WaitConditionHandle' });
				return { originHandle: { domainName: 'x.example', protocol: 'https' } };
			}
		}
		assert.throws(() => assertAdapterConformance(new NoUrlDoor(), { scope: freshScope() }), /url/);
	});
});
