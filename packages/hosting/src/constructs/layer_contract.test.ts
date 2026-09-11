import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { CapabilityPlan } from '../plan/types.js';
import { AlbAdapter } from './alb_adapter.js';
import { ApiGatewayAdapter } from './apigw_adapter.js';
import { S3WebsiteAdapter } from './s3_website_adapter.js';

const staticPlan: CapabilityPlan = {
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: { entries: [], redirects: [], headers: [] },
  policies: { spaFallback: true, hasServer: false, skewEnabled: false },
  release: { buildId: 'b1' },
};

const staticDir = mkdtempSync(join(tmpdir(), 'layer-'));
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>x</title>');

const freshStack = (id: string) => {
  const app = new App();
  const stack = new Stack(app, id, { env: { account: '111111111111', region: 'us-west-2' } });
  return stack;
};

describe('layer-render contract — renderLayer returns an attachable originHandle', () => {
  it('s3-website: origin handle is the website host, protocol http', () => {
    const stack = freshStack('S1');
    const h = new S3WebsiteAdapter().renderLayer(stack, staticPlan, { staticDir });
    assert.ok(h.url, 'root layer has a public url');
    assert.equal(h.originHandle.protocol, 'http');
    assert.ok(h.originHandle.domainName, 'has a domainName a parent can attach to');
  });

  it('api-gateway: origin handle protocol https', () => {
    const stack = freshStack('S2');
    const bucket = new Bucket(stack, 'Assets');
    const h = new ApiGatewayAdapter().renderLayer(stack, staticPlan, { bucket });
    assert.ok(h.url);
    assert.equal(h.originHandle.protocol, 'https');
  });

  it('alb: origin handle is the LB DNS; protocol reflects the certificate (http without one)', () => {
    const stack = freshStack('S3');
    const bucket = new Bucket(stack, 'Assets');
    const h = new AlbAdapter().renderLayer(stack, staticPlan, { bucket });
    assert.ok(h.url);
    assert.equal(h.originHandle.protocol, 'http'); // no certificate → HTTP listener
    assert.ok(h.originHandle.domainName);
  });

  it('render() delegates to renderLayer — still yields a real URL (not the fallback)', () => {
    // render() forwards renderLayer().url; guard that the delegation produces a
    // real value (a CDK token for the website URL), never the '' safety fallback.
    const { url } = new S3WebsiteAdapter().render(freshStack('S4'), staticPlan, { staticDir });
    assert.ok(url && url !== '', 'render() returns the layer URL');
  });
});
