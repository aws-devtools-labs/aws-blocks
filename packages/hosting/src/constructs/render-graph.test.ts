import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { composeGraph } from '../plan/compose.js';
import type { CapabilityPlan, FrontDoorGraph } from '../plan/types.js';
import { renderGraph } from './render-graph.js';

const staticPlan: CapabilityPlan = {
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: { entries: [], redirects: [], headers: [] },
  policies: { spaFallback: true, hasServer: false, skewEnabled: false },
  release: { buildId: 'b1' },
};

const staticDir = mkdtempSync(join(tmpdir(), 'rg-'));
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>x</title>');

const freshStack = (id: string) => new Stack(new App(), id, { env: { account: '111111111111', region: 'us-west-2' } });

describe('renderGraph — graph-driven dispatch (single layer)', () => {
  it('renders an s3-website graph → a LayerHandle with a URL', () => {
    const h = renderGraph(freshStack('S1'), composeGraph(staticPlan, 's3-website'), staticPlan, { staticDir });
    assert.ok(h.url);
    assert.equal(h.originHandle.protocol, 'http');
  });

  it('renders an api-gateway graph via its adapter', () => {
    const stack = freshStack('S2');
    const bucket = new Bucket(stack, 'Assets');
    const h = renderGraph(stack, composeGraph(staticPlan, 'api-gateway'), staticPlan, { bucket });
    assert.ok(h.url);
    assert.equal(h.originHandle.protocol, 'https');
  });

  it('rejects a nested composition (edge → router) as not-yet-supported', () => {
    // Hand-build a two-layer graph: CloudFront edge whose child is an ALB router.
    const nested: FrontDoorGraph = {
      root: {
        service: 'cloudfront',
        role: 'edge',
        forwards: [{ match: 'api:*', to: { service: 'alb', role: 'router', forwards: [] } }],
      },
    };
    assert.throws(() => renderGraph(freshStack('S3'), nested, staticPlan, {}), /not supported yet/);
  });

  it('rejects an unknown layer service', () => {
    const bad: FrontDoorGraph = { root: { service: 'nope', role: 'edge', forwards: [] } };
    assert.throws(() => renderGraph(freshStack('S4'), bad, staticPlan, {}), /Unknown front-door layer service/);
  });
});
