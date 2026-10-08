import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requiredCapabilities } from './negotiate.js';
import type { CapabilityPlan } from './types.js';

const planWith = (over: Partial<CapabilityPlan> = {}): CapabilityPlan => ({
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: { entries: [], redirects: [], headers: [] },
  policies: { spaFallback: false, hasServer: false, skewEnabled: false },
  release: { buildId: 'b1' },
  ...over,
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
  });

  it('requires RouteApiNamespace for a named namespace', () => {
    const req = requiredCapabilities(
      planWith({
        backend: {
          origins: [{ namespace: 'notes', ingress: { kind: 'url', url: 'https://x/aws-blocks/api' } }],
        },
      }),
    );
    assert.ok(req.has('ProxySameOriginApi') && req.has('RouteApiNamespace'));
  });

  it('requires nothing backend-related when there is no backend (cross-origin API)', () => {
    const req = requiredCapabilities(planWith());
    assert.ok(!req.has('ProxySameOriginApi') && !req.has('RouteApiNamespace'));
  });
});
