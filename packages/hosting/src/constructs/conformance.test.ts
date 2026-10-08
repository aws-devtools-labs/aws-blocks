import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, CfnResource, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { CapabilityPlan } from '../plan/types.js';
import { assertDoorConformance } from './conformance.js';
import { defineFrontDoor, type FrontDoorHooks, type RouteReport } from './door_hooks.js';
import type { LayerHandle } from './layer.js';

/** A conforming door: core hooks only, serves static, returns a well-formed handle. */
const goodDoor = (overrides: Partial<FrontDoorHooks<Construct>> = {}): FrontDoorHooks<Construct> =>
	defineFrontDoor<Construct>({
		service: 'good-edge',
		create: (scope) => new CfnResource(scope, 'GoodDoorRes', { type: 'AWS::CloudFormation::WaitConditionHandle' }),
		route: () => ({}),
		handle: (): LayerHandle => ({
			url: 'https://good.example',
			originHandle: { domainName: 'good.example', protocol: 'https' },
		}),
		...overrides,
	});

const ssrPlan: CapabilityPlan = {
	origins: [
		{ id: 'blocks-s3', kind: 'static' },
		{ id: 'blocks-server', kind: 'server' },
	],
	routes: { entries: [{ pattern: '/*', kind: 'server' }], redirects: [], headers: [] },
	policies: { spaFallback: false, hasServer: true, skewEnabled: false },
	release: { buildId: 'b1' },
};

const freshScope = () => new Stack(new App(), 'S', { env: { account: '111111111111', region: 'us-east-1' } });

describe('assertDoorConformance', () => {
	it('passes for a well-formed door and returns what it delivered', () => {
		const run = assertDoorConformance(goodDoor(), { scope: freshScope() });
		assert.ok(run.delivered.has('RouteRequest'));
		assert.ok(run.delivered.has('ServeStaticAsset'));
	});

	it('fails when `service` is missing', () => {
		assert.throws(() => assertDoorConformance(goodDoor({ service: '' }), { scope: freshScope() }), /service/);
	});

	it('fails when a required core hook is not a function', () => {
		const door = { ...goodDoor(), route: 'nope' } as unknown as FrontDoorHooks<Construct>;
		assert.throws(() => assertDoorConformance(door, { scope: freshScope() }), /`route` hook must be a function/);
	});

	it('fails when an optional feature hook is present but not a function', () => {
		const door = { ...goodDoor(), waf: true } as unknown as FrontDoorHooks<Construct>;
		assert.throws(() => assertDoorConformance(door, { scope: freshScope() }), /`waf` must be a function or omitted/);
	});

	it('fails when the door cannot serve the plan it is handed (no ssr report)', () => {
		assert.throws(
			() => assertDoorConformance(goodDoor(), { scope: freshScope(), plan: ssrPlan }),
			/does not serve|RunServerRender/,
		);
	});

	it('passes the SSR plan once route() reports ssr + atomic release', () => {
		const door = goodDoor({ route: (): RouteReport => ({ ssr: 'buffered', atomicRelease: true }) });
		assert.doesNotThrow(() => assertDoorConformance(door, { scope: freshScope(), plan: ssrPlan }));
	});

	it('fails when route() reports a bogus ssr flavor', () => {
		const door = goodDoor({ route: () => ({ ssr: 'sometimes' }) as unknown as RouteReport });
		assert.throws(() => assertDoorConformance(door, { scope: freshScope() }), /expected false \| 'buffered'/);
	});

	it('fails when handle() returns a handle without a usable originHandle', () => {
		const door = goodDoor({ handle: () => ({ url: 'https://x.example', originHandle: { domainName: '', protocol: 'https' } }) });
		assert.throws(() => assertDoorConformance(door, { scope: freshScope() }), /domainName/);
	});

	it('fails when handle() omits the public url on the root layer', () => {
		const door = goodDoor({ handle: () => ({ originHandle: { domainName: 'x.example', protocol: 'https' } }) });
		assert.throws(() => assertDoorConformance(door, { scope: freshScope() }), /url/);
	});
});
