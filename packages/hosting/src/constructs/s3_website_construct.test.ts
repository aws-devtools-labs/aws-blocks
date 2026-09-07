import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { CapabilityPlan } from '../plan/types.js';
import { S3WebsiteConstruct } from './s3_website_construct.js';
import { S3WebsiteAdapter } from './s3_website_adapter.js';

const staticDir = mkdtempSync(join(tmpdir(), 's3site-'));
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>x</title>');

const spaPlan: CapabilityPlan = {
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: { entries: [], redirects: [], headers: [] },
  policies: { spaFallback: true, hasServer: false, skewEnabled: false },
  release: { buildId: 'testbuild' },
};

describe('S3WebsiteConstruct — static/SPA', () => {
  const app = new App();
  const stack = new Stack(app, 'S', { env: { account: '111111111111', region: 'us-west-2' } });
  new S3WebsiteConstruct(stack, 'Site', { plan: spaPlan, staticDir });
  const t = Template.fromStack(stack);

  it('creates a website bucket with index + error documents (SPA → index.html)', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      WebsiteConfiguration: { IndexDocument: 'index.html', ErrorDocument: 'index.html' },
    });
  });
});

describe('S3WebsiteAdapter — capability matrix + negotiation', () => {
  const a = new S3WebsiteAdapter();
  it('is the s3-website service; dynamic + TLS unsupported', () => {
    assert.equal(a.service, 's3-website');
    assert.equal(a.supports('ServeStaticAsset'), 'extended');
    assert.equal(a.supports('CustomDomainTls'), 'unsupported');
    assert.equal(a.supports('RunServerRender'), 'unsupported');
  });
  it('renders a pure-static SPA plan (no atomicity opt-in needed)', () => {
    const app = new App();
    const stack = new Stack(app, 'S2', { env: { account: '111111111111', region: 'us-west-2' } });
    assert.ok(new S3WebsiteAdapter().render(stack, spaPlan, { staticDir }).url);
  });
  it('rejects an SSR plan', () => {
    const app = new App();
    const stack = new Stack(app, 'S3', { env: { account: '111111111111', region: 'us-west-2' } });
    const ssrPlan: CapabilityPlan = {
      ...spaPlan,
      origins: [
        { id: 'blocks-s3', kind: 'static' },
        { id: 'blocks-server', kind: 'server' },
      ],
      policies: { ...spaPlan.policies, hasServer: true },
    };
    assert.throws(() => new S3WebsiteAdapter().render(stack, ssrPlan, { staticDir }), /RunServerRender/);
  });
});
