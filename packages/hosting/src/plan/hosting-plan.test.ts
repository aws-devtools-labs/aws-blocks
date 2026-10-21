import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DeployManifest, RouteBehavior } from '../manifest/types.js';
import { buildCapabilityPlan, ORIGIN_IDS } from './capability-plan.js';

const manifestWith = (routes: RouteBehavior[], extra: Partial<DeployManifest> = {}): DeployManifest => ({
  version: 1,
  compute: {},
  staticAssets: { directory: '/tmp/static' },
  routes,
  ...extra,
});

describe('buildCapabilityPlan — origins', () => {
  it('always includes the static origin', () => {
    const plan = buildCapabilityPlan({
      manifest: manifestWith([]),
      buildId: 'b1',
      hasServer: false,
      hasImage: false,
    });
    assert.deepEqual(plan.origins, [{ id: ORIGIN_IDS.static, kind: 'static' }]);
  });

  it('adds server and image origins when present', () => {
    const plan = buildCapabilityPlan({
      manifest: manifestWith([]),
      buildId: 'b1',
      hasServer: true,
      hasImage: true,
    });
    assert.deepEqual(plan.origins, [
      { id: ORIGIN_IDS.static, kind: 'static' },
      { id: ORIGIN_IDS.server, kind: 'server' },
      { id: ORIGIN_IDS.image, kind: 'image' },
    ]);
  });
});

describe('buildCapabilityPlan — routes, redirects, headers', () => {
  it('exposes the neutral route table and basePath-resolves redirects + headers', () => {
    const manifest = manifestWith([{ pattern: '/a', target: 'static' }], {
      basePath: '/app',
      redirects: [{ source: '/old', destination: '/new', statusCode: 308 }],
      headers: [{ source: '/secure/*', headers: { 'X-Frame-Options': 'DENY' } }],
    });
    const plan = buildCapabilityPlan({ manifest, buildId: 'b1', hasServer: true, hasImage: false });

    assert.equal(plan.routes.entries[0]?.pattern, '/app/a');
    assert.deepEqual(plan.routes.redirects, [
      { source: '/app/old', destination: '/app/new', statusCode: 308 },
    ]);
    assert.deepEqual(plan.routes.headers, [
      { pattern: '/app/secure/*', headers: { 'X-Frame-Options': 'DENY' } },
    ]);
  });
});

describe('buildCapabilityPlan — policies + release', () => {
  it('carries the cross-cutting policy flags and buildId', () => {
    const manifest = manifestWith([], {
      basePath: '/app',
      assetPrefix: '/cdn',
      imageOptimization: { bundle: '/x', handler: 'h', formats: [], sizes: [], baseURL: '/_ipx' },
      staticAssets: { directory: '/tmp/static', spaFallback: true },
    });
    const plan = buildCapabilityPlan({
      manifest,
      buildId: 'build-123',
      hasServer: true,
      hasImage: true,
      wwwRedirect: 'toApex',
      skewEnabled: true,
    });

    assert.deepEqual(plan.policies, {
      basePath: '/app',
      assetPrefix: '/cdn',
      imagePrefix: '/_ipx',
      spaFallback: true,
      hasServer: true,
      wwwRedirect: 'toApex',
      skewEnabled: true,
    });
    assert.equal(plan.release.buildId, 'build-123');
  });

  it('defaults skewEnabled/spaFallback to false and imagePrefix to undefined without an image origin', () => {
    const plan = buildCapabilityPlan({
      manifest: manifestWith([]),
      buildId: 'b1',
      hasServer: false,
      hasImage: false,
    });
    assert.equal(plan.policies.skewEnabled, false);
    assert.equal(plan.policies.spaFallback, false);
    assert.equal(plan.policies.imagePrefix, undefined);
  });
});
