import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, CfnResource, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { CapabilityPlan } from '../plan/types.js';
import { renderCustomDoor } from './custom_door.js';
import { defineFrontDoor, type RouteReport } from './door_hooks.js';

const staticPlan: CapabilityPlan = {
	origins: [{ id: 'blocks-s3', kind: 'static' }],
	routes: { entries: [{ pattern: '/assets/*', kind: 'static' }], redirects: [], headers: [] },
	policies: { spaFallback: true, hasServer: false, skewEnabled: false },
	release: { buildId: 'testbuild' },
};

// A plan that DEMANDS RunServerRender + AtomicRelease (hasServer) and a WAF.
const ssrWafPlan: CapabilityPlan = {
	origins: [
		{ id: 'blocks-s3', kind: 'static' },
		{ id: 'blocks-server', kind: 'server' },
	],
	routes: { entries: [{ pattern: '/*', kind: 'server' }], redirects: [], headers: [] },
	policies: { spaFallback: false, hasServer: true, skewEnabled: false, wafEnabled: true },
	release: { buildId: 'testbuild' },
};

/** A minimal customer-authored door. `report` is what route() says it built; `withWaf` adds the waf hook. */
const fakeDoor = (opts: { report?: RouteReport; withWaf?: boolean } = {}) => {
	const calls: string[] = [];
	const door = defineFrontDoor<Construct>({
		service: 'fake-edge',
		create(scope) {
			calls.push('create');
			return new CfnResource(scope, 'FakeDoorRes', { type: 'AWS::CloudFormation::WaitConditionHandle' });
		},
		route() {
			calls.push('route');
			return opts.report ?? { ssr: 'buffered', atomicRelease: true };
		},
		handle() {
			calls.push('handle');
			return { url: 'https://fake.example', originHandle: { domainName: 'fake.example', protocol: 'https' } };
		},
		...(opts.withWaf
			? {
					waf: () => {
						calls.push('waf');
						return 'regional' as const;
					},
				}
			: {}),
	});
	return { door, calls };
};

const stack = () => new Stack(new App(), 'S', { env: { account: '111111111111', region: 'us-west-2' } });

describe('renderCustomDoor', () => {
	it('runs the hooks in order and returns the handle when every demand is met', () => {
		const { door, calls } = fakeDoor({ withWaf: true });
		const handle = renderCustomDoor(stack(), ssrWafPlan, door, {});
		assert.deepEqual(calls, ['create', 'route', 'waf', 'handle']);
		assert.equal(handle.url, 'https://fake.example');
		assert.equal(handle.originHandle.domainName, 'fake.example');
	});

	it('does not call a feature hook the app did not demand', () => {
		const { door, calls } = fakeDoor({ withWaf: true });
		renderCustomDoor(stack(), staticPlan, door, {});
		assert.deepEqual(calls, ['create', 'route', 'handle']);
	});

	it('fails BEFORE building when a demanded capability has no hook', () => {
		const { door, calls } = fakeDoor({ withWaf: false });
		assert.throws(() => renderCustomDoor(stack(), ssrWafPlan, door, {}), /FilterRequests/);
		assert.deepEqual(calls, [], 'nothing is built when a hook is missing');
	});

	it('fails AFTER route when route() does not report a demanded capability', () => {
		const { door, calls } = fakeDoor({ withWaf: true, report: { atomicRelease: true } });
		assert.throws(
			() => renderCustomDoor(stack(), ssrWafPlan, door, {}, { negotiation: 'strict' }),
			/RunServerRender/,
		);
		assert.ok(!calls.includes('handle'), 'handle is not reached on a failed report check');
	});

	it('builds when a missing capability is explicitly waived via degrade', () => {
		const { door, calls } = fakeDoor({ withWaf: false });
		const handle = renderCustomDoor(stack(), ssrWafPlan, door, {}, { degrade: ['FilterRequests'] });
		assert.deepEqual(calls, ['create', 'route', 'handle']);
		assert.equal(handle.url, 'https://fake.example');
	});

	it("negotiation: 'warn' builds despite an unmet demand", () => {
		const { door, calls } = fakeDoor({ withWaf: false, report: {} });
		renderCustomDoor(stack(), ssrWafPlan, door, {}, { negotiation: 'warn' });
		assert.deepEqual(calls, ['create', 'route', 'handle']);
	});

	it("negotiation: 'off' builds without checking, still calling the hooks that exist", () => {
		const { door, calls } = fakeDoor({ withWaf: true, report: {} });
		renderCustomDoor(stack(), ssrWafPlan, door, {}, { negotiation: 'off' });
		assert.deepEqual(calls, ['create', 'route', 'waf', 'handle']);
	});

	it('rejects an unknown negotiation mode', () => {
		const { door } = fakeDoor();
		assert.throws(
			() => renderCustomDoor(stack(), staticPlan, door, {}, { negotiation: 'loose' as never }),
			/Unknown negotiation mode/,
		);
	});
});
