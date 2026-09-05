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
  it('always requires routing, static serving, atomic release', () => {
    const req = requiredCapabilities(planWith());
    assert.ok(req.has('RouteRequest') && req.has('ServeStaticAsset') && req.has('AtomicRelease'));
    assert.ok(!req.has('RunServerRender'));
  });

  it('requires RunServerRender / OptimizeImage / PinSession / InjectResponseHeaders when the plan shows them', () => {
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
    assert.ok(req.has('RunServerRender') && req.has('OptimizeImage') && req.has('PinSession') && req.has('InjectResponseHeaders'));
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
});
