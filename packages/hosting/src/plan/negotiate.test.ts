import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { negotiate, requiredCapabilities } from './negotiate.js';
import type { CapabilityPlan, FrontDoorAdapter, CapabilityId, SupportTier } from './types.js';

const planWith = (over: Partial<CapabilityPlan> = {}): CapabilityPlan => ({
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: { entries: [], redirects: [], headers: [] },
  policies: { spaFallback: false, hasServer: false, skewEnabled: false },
  release: { buildId: 'b1' },
  ...over,
});

const adapterWith = (tiers: Partial<Record<CapabilityId, SupportTier>>): FrontDoorAdapter => ({
  service: 'test',
  supports: (c) => tiers[c] ?? 'core',
  render: () => ({ url: 'http://x' }),
});

describe('requiredCapabilities', () => {
  it('always requires routing + static serving; atomic release only with a server', () => {
    const req = requiredCapabilities(planWith());
    assert.ok(req.has('RouteRequest') && req.has('ServeStaticAsset'));
    assert.ok(!req.has('RunServerRender'));
    assert.ok(!req.has('AtomicRelease'), 'pure-static deploy should not require AtomicRelease');
  });

  it('requires RunServerRender / AtomicRelease / OptimizeImage / PinSession / InjectResponseHeaders when the plan shows them', () => {
    const req = requiredCapabilities(
      planWith({
        origins: [
          { id: 'blocks-s3', kind: 'static' },
          { id: 'blocks-server', kind: 'server' },
          { id: 'blocks-image', kind: 'image' },
        ],
        routes: { entries: [], redirects: [], headers: [{ pattern: '/*', headers: { X: '1' } }] },
        policies: { spaFallback: false, hasServer: true, skewEnabled: true },
      }),
    );
    assert.ok(req.has('RunServerRender') && req.has('AtomicRelease') && req.has('OptimizeImage') && req.has('PinSession') && req.has('InjectResponseHeaders'));
  });

  it('requires ProxySameOriginApi when the plan proxies the API same-origin; no RouteApiNamespace for a lone `*` origin', () => {
    const req = requiredCapabilities(
      planWith({ backend: { origins: [{ namespace: '*', ingress: { kind: 'url', url: 'https://x/aws-blocks/api' } }] } }),
    );
    assert.ok(req.has('ProxySameOriginApi'));
    assert.ok(!req.has('RouteApiNamespace'), 'single-compute `*` should not require namespace path-routing');
    assert.ok(!req.has('LongRequest') && !req.has('LargePayload'));
  });

  it('requires RouteApiNamespace for a named namespace, and payload/timeout caps when declared', () => {
    const req = requiredCapabilities(
      planWith({
        backend: {
          origins: [{ namespace: 'notes', ingress: { kind: 'url', url: 'https://x/aws-blocks/api' } }],
          needsLongRequests: true,
          needsLargePayloads: true,
        },
      }),
    );
    assert.ok(req.has('ProxySameOriginApi') && req.has('RouteApiNamespace'));
    assert.ok(req.has('LongRequest') && req.has('LargePayload'));
  });

  it('requires nothing backend-related when there is no backend (cross-origin API)', () => {
    const req = requiredCapabilities(planWith());
    assert.ok(!req.has('ProxySameOriginApi') && !req.has('RouteApiNamespace'));
  });
});

describe('negotiate', () => {
  it('errors on a required + unsupported capability', () => {
    const { errors } = negotiate(planWith(), adapterWith({ ServeStaticAsset: 'unsupported' }));
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.capability, 'ServeStaticAsset');
  });

  it('errors on a required + degraded capability without opt-in', () => {
    const plan = planWith({ policies: { spaFallback: false, hasServer: false, skewEnabled: true } });
    const { errors } = negotiate(plan, adapterWith({ PinSession: 'degraded' }));
    assert.ok(errors.some((e) => e.capability === 'PinSession'));
  });

  it('warns (not errors) on a degraded capability the app opted into', () => {
    const plan = planWith({ policies: { spaFallback: false, hasServer: false, skewEnabled: true } });
    const { errors, warnings } = negotiate(plan, adapterWith({ PinSession: 'degraded' }), { degrade: ['PinSession'] });
    assert.equal(errors.length, 0);
    assert.ok(warnings.some((w) => w.capability === 'PinSession'));
  });

  it('is silent for a fully core/extended adapter', () => {
    const { errors, warnings } = negotiate(planWith(), adapterWith({ RouteRequest: 'extended' }));
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 0);
  });

  it('errors when a plan needs LongRequest on a door that cannot (e.g. API Gateway 29 s cap)', () => {
    const plan = planWith({
      backend: { origins: [{ namespace: '*', ingress: { kind: 'url', url: 'https://x/aws-blocks/api' } }], needsLongRequests: true },
    });
    const { errors } = negotiate(plan, adapterWith({ LongRequest: 'unsupported' }));
    assert.ok(errors.some((e) => e.capability === 'LongRequest'));
  });

  it('errors when a multi-namespace plan hits a single-origin door (RouteApiNamespace unsupported)', () => {
    const plan = planWith({
      backend: { origins: [{ namespace: 'notes', ingress: { kind: 'url', url: 'https://x/aws-blocks/api' } }] },
    });
    const { errors } = negotiate(plan, adapterWith({ RouteApiNamespace: 'unsupported' }));
    assert.ok(errors.some((e) => e.capability === 'RouteApiNamespace'));
  });
});
