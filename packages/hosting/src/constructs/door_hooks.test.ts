import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, CfnResource, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { CapabilityId, CapabilityPlan } from '../plan/types.js';
import { albDoor } from './alb_door.js';
import { apiGatewayDoor } from './apigw_door.js';
import { cloudFrontDoor } from './cloudfront_door.js';
import { cloudFrontEdgeDoor } from './cloudfront_edge_door.js';
import {
	ALL_CAPABILITIES,
	CAPABILITY_SOURCE,
	defineFrontDoor,
	type FeatureHookName,
	type FrontDoorHooks,
	runFrontDoor,
} from './door_hooks.js';
import { s3WebsiteDoor } from './s3_website_door.js';

/** A plan that demands EVERY capability (server, image, redirects, headers, all opt-ins, named namespace). */
const maximalPlan: CapabilityPlan = {
	origins: [
		{ id: 'blocks-s3', kind: 'static' },
		{ id: 'blocks-server', kind: 'server' },
		{ id: 'blocks-image', kind: 'image' },
	],
	routes: {
		entries: [],
		redirects: [{ source: '/a', destination: '/b', statusCode: 301 }],
		headers: [{ pattern: '/*', headers: { X: '1' } }],
	},
	policies: {
		spaFallback: false,
		hasServer: true,
		skewEnabled: true,
		customDomain: true,
		wafEnabled: true,
		loggingEnabled: true,
		hasCustomErrorPages: true,
		hasRedirects: true,
		needsStreaming: true,
		geoRestricted: true,
		monitoringEnabled: true,
		edgeCacheRequired: true,
	},
	release: { buildId: 'b1' },
	backend: { origins: [{ namespace: 'notes', ingress: { kind: 'url', url: 'https://x/aws-blocks/api' } }] },
};

const staticPlan: CapabilityPlan = {
	origins: [{ id: 'blocks-s3', kind: 'static' }],
	routes: { entries: [], redirects: [], headers: [] },
	policies: { spaFallback: true, hasServer: false, skewEnabled: false },
	release: { buildId: 'b1' },
};

/**
 * What a door delivers for the maximal plan, read off its hooks — the hooks
 * model's "support matrix". Hooks are run against a throwaway state object (they
 * only record props), never building a construct.
 */
// biome-ignore lint/suspicious/noExplicitAny: test helper drives every door's hooks generically.
const supportOf = (door: FrontDoorHooks<any, any>, state: unknown, ctx: unknown = {}): Set<CapabilityId> => {
	const report = door.route(state, maximalPlan, ctx);
	const out = new Set<CapabilityId>();
	for (const cap of ALL_CAPABILITIES) {
		const s = CAPABILITY_SOURCE[cap];
		if (s.kind === 'core') out.add(cap);
		else if (s.kind === 'report') {
			if (s.delivered(report)) out.add(cap);
		} else {
			const hook = door[s.hook] as ((...args: unknown[]) => unknown) | undefined;
			if (typeof hook !== 'function') continue;
			const result =
				s.hook === 'sameOriginApi' ? hook.call(door, state, maximalPlan.backend, ctx) : hook.call(door, state, ctx);
			if (!s.delivered || s.delivered(result)) out.add(cap);
		}
	}
	return out;
};

const supported = (caps: CapabilityId[]) => new Set<CapabilityId>(caps);
const freshStack = (id = 'S') => new Stack(new App(), id, { env: { account: '111111111111', region: 'us-west-2' } });

describe('CAPABILITY_SOURCE — every capability names how a door delivers it', () => {
	it('covers the whole vocabulary', () => {
		assert.deepEqual(Object.keys(CAPABILITY_SOURCE).sort(), [...ALL_CAPABILITIES].sort());
	});

	it('every hook-backed capability names a real feature hook', () => {
		const hooks: FeatureHookName[] = ['sameOriginApi', 'customDomain', 'waf', 'restrictGeo', 'accessLogs', 'alarms'];
		for (const cap of ALL_CAPABILITIES) {
			const s = CAPABILITY_SOURCE[cap];
			if (s.kind === 'hook') assert.ok(hooks.includes(s.hook), `${cap} → ${s.hook}`);
		}
	});
});

describe('built-in doors — support read off their hooks (mirrors #510’s matrices)', () => {
	it('cloudfront delivers every capability', () => {
		const state = { scope: freshStack(), props: {} };
		assert.deepEqual(supportOf(cloudFrontDoor, state, { cdnProps: {} }), new Set(ALL_CAPABILITIES));
	});

	it('alb: no edge cache, response headers, error pages, session pinning, or geo', () => {
		const state = { scope: freshStack(), props: {} };
		assert.deepEqual(
			supportOf(albDoor, state),
			supported([
				'RouteRequest',
				'ServeStaticAsset',
				'RunServerRender',
				'StreamServerRender',
				'ProxySameOriginApi',
				'RouteApiNamespace',
				'CustomDomainTls',
				'FilterRequests',
				'AtomicRelease',
				'OptimizeImage',
				'AccessLogging',
				'Redirect',
				'Alarms',
			]),
		);
	});

	it('api-gateway: buffered SSR only; no WAF / logs / alarms / redirects / edge features', () => {
		const state = { scope: freshStack(), props: {} };
		assert.deepEqual(
			supportOf(apiGatewayDoor, state),
			supported([
				'RouteRequest',
				'ServeStaticAsset',
				'RunServerRender',
				'ProxySameOriginApi',
				'RouteApiNamespace',
				'CustomDomainTls',
				'AtomicRelease',
				'OptimizeImage',
			]),
		);
	});

	it('s3-website: static routing only', () => {
		assert.deepEqual(supportOf(s3WebsiteDoor, { scope: freshStack() }), supported(['RouteRequest', 'ServeStaticAsset']));
	});

	it('cloudfront-edge (stacked): caching + headers + a BYO edge WAF', () => {
		const caps = supportOf(cloudFrontEdgeDoor, { scope: freshStack() }, {});
		for (const cap of ['CacheResponses', 'InjectResponseHeaders', 'FilterRequests'] as const) assert.ok(caps.has(cap), cap);
		assert.ok(!caps.has('CustomDomainTls'), 'no customDomain hook on the edge yet');
	});
});

describe('runFrontDoor', () => {
	const make = (extra: Partial<FrontDoorHooks<Construct>> = {}) => {
		const calls: string[] = [];
		const door = defineFrontDoor<Construct>({
			service: 'probe',
			create(scope) {
				calls.push('create');
				return new CfnResource(scope, 'Probe', { type: 'AWS::CloudFormation::WaitConditionHandle' });
			},
			route() {
				calls.push('route');
				return {};
			},
			handle() {
				calls.push('handle');
				return { url: 'https://p.example', originHandle: { domainName: 'p.example', protocol: 'https' } };
			},
			...extra,
		});
		return { door, calls };
	};

	it('a static plan needs only the core hooks', () => {
		const { door, calls } = make();
		const run = runFrontDoor(freshStack(), staticPlan, door, {});
		assert.deepEqual(calls, ['create', 'route', 'handle']);
		assert.deepEqual(run.unmet, []);
		assert.equal(run.handle.url, 'https://p.example');
	});

	it('RouteApiNamespace is delivered only when sameOriginApi reports namespaced', () => {
		const namespacedPlan: CapabilityPlan = { ...staticPlan, backend: maximalPlan.backend };
		const single = make({ sameOriginApi: () => 'single' });
		assert.throws(() => runFrontDoor(freshStack('A'), namespacedPlan, single.door, {}), /RouteApiNamespace/);
		const multi = make({ sameOriginApi: () => 'namespaced' });
		assert.doesNotThrow(() => runFrontDoor(freshStack('B'), namespacedPlan, multi.door, {}));
	});

	it('uses the caller-supplied errorCode', () => {
		const { door } = make();
		assert.throws(
			() => runFrontDoor(freshStack(), maximalPlan, door, {}, { errorCode: 'CapabilityNotSupportedError' }),
			(e: Error) => e.name === 'CapabilityNotSupportedError',
		);
	});

	it("'off' reports what was not delivered without failing", () => {
		const { door } = make();
		const run = runFrontDoor(freshStack(), maximalPlan, door, {}, { negotiation: 'off' });
		assert.ok(run.unmet.includes('RunServerRender'));
		assert.ok(run.unmet.includes('FilterRequests'));
	});

	it('the required override narrows what is checked (used by the stacked edge)', () => {
		const { door, calls } = make();
		runFrontDoor(freshStack(), maximalPlan, door, {}, { required: [] });
		assert.deepEqual(calls, ['create', 'route', 'handle']);
	});
});
