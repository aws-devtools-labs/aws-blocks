import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { composeCloudFrontOverRouter, composeGraph } from '../plan/compose.js';
import type { CapabilityPlan, FrontDoorGraph } from '../plan/types.js';
import { createSecurityHeadersPolicy } from './security_headers.js';
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

  it('renders a nested composition bottom-up: CloudFront edge → ALB router (CF → ALB)', () => {
    const stack = freshStack('S3');
    const bucket = new Bucket(stack, 'Assets');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    // Shared ctx superset: CloudFront reads cdnProps; the ALB child reads bucket.
    const ctx = { cdnProps: { bucket, manifest: { version: 1, compute: {}, staticAssets: { directory: '.' }, routes: [{ pattern: '/*', target: 'static' }], buildId: 'b1' }, securityHeadersPolicy: policy }, bucket };
    const graph = composeCloudFrontOverRouter(staticPlan, 'alb');
    const h = renderGraph(stack, graph, staticPlan, ctx);
    assert.ok(h.url);

    const t = Template.fromStack(stack);
    // Both layers materialized: a CloudFront distribution AND an ALB…
    t.resourceCountIs('AWS::CloudFront::Distribution', 1);
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    // …and the edge fronts the child at the API subtree path.
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: '/aws-blocks/api/*' })]),
      }),
    });
  });

  it('rejects an unknown layer service', () => {
    const bad: FrontDoorGraph = { root: { service: 'nope', role: 'edge', forwards: [] } };
    assert.throws(() => renderGraph(freshStack('S4'), bad, staticPlan, {}), /Unknown front-door layer service/);
  });
});
