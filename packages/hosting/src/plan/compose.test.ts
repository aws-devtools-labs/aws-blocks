import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composeGraph } from './compose.js';
import { isOriginRef } from './types.js';
import type { CapabilityPlan, FrontDoorLayer, OriginRef } from './types.js';

const staticPlan: CapabilityPlan = {
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: { entries: [], redirects: [], headers: [] },
  policies: { spaFallback: true, hasServer: false, skewEnabled: false },
  release: { buildId: 'b1' },
};

const ssrPlan: CapabilityPlan = {
  origins: [
    { id: 'blocks-s3', kind: 'static' },
    { id: 'blocks-server', kind: 'server' },
    { id: 'blocks-image', kind: 'image' },
  ],
  routes: { entries: [], redirects: [], headers: [] },
  policies: { spaFallback: false, hasServer: true, skewEnabled: false },
  release: { buildId: 'b1' },
  backend: { origins: [{ namespace: '*', ingress: { kind: 'url', url: 'https://x/aws-blocks/api' } }] },
};

const originIds = (layer: FrontDoorLayer): string[] =>
  layer.forwards
    .map((f) => f.to)
    .filter((t): t is Extract<OriginRef, { kind: 'plan-origin' }> => isOriginRef(t) && t.kind === 'plan-origin')
    .map((t) => t.originId);

describe('composeGraph — single-layer topologies (Commit 1: representation only)', () => {
  it('cloudfront + static → an EDGE over the S3 origin (CF → S3, no compute)', () => {
    const g = composeGraph(staticPlan, 'cloudfront');
    assert.equal(g.root.service, 'cloudfront');
    assert.equal(g.root.role, 'edge');
    assert.deepEqual(originIds(g.root), ['blocks-s3']);
  });

  it('cloudfront + SSR → an EDGE over S3 + server + image + the backend', () => {
    const g = composeGraph(ssrPlan, 'cloudfront');
    assert.equal(g.root.role, 'edge');
    assert.deepEqual(originIds(g.root).sort(), ['blocks-image', 'blocks-s3', 'blocks-server']);
    // The backend origin is an external forward (api:*), not a plan-origin.
    const api = g.root.forwards.find((f) => f.match === 'api:*');
    assert.ok(api && isOriginRef(api.to) && api.to.kind === 'external');
  });

  it('s3-website → a single ORIGIN front (static only, no backend routing)', () => {
    const g = composeGraph(ssrPlan, 's3-website');
    assert.equal(g.root.service, 's3-website');
    assert.equal(g.root.role, 'origin');
    assert.deepEqual(originIds(g.root), ['blocks-s3']);
    assert.ok(!g.root.forwards.some((f) => f.match.startsWith('api:')), 's3-website does not proxy the API');
  });

  it('alb / api-gateway → a ROUTER over the origins + backend', () => {
    for (const choice of ['alb', 'api-gateway'] as const) {
      const g = composeGraph(ssrPlan, choice);
      assert.equal(g.root.role, 'router');
      assert.ok(g.root.forwards.some((f) => f.match === 'api:*'));
    }
  });

  it('function-url → a single static origin front', () => {
    const g = composeGraph(staticPlan, 'function-url');
    assert.equal(g.root.role, 'origin');
    assert.deepEqual(originIds(g.root), ['blocks-s3']);
  });

  it('the graph type admits nesting (edge → router) even though composeGraph does not emit it yet', () => {
    // A hand-built two-layer graph type-checks and traverses — proves the model
    // supports composition the pick-one enum cannot express.
    const nested = composeGraph(ssrPlan, 'cloudfront');
    const router = composeGraph(ssrPlan, 'alb').root;
    nested.root.forwards.push({ match: 'api:orders', to: router });
    const child = nested.root.forwards.find((f) => f.match === 'api:orders')?.to;
    assert.ok(child && !isOriginRef(child) && child.role === 'router');
  });
});
