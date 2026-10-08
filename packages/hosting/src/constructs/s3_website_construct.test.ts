import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { CapabilityPlan } from '../plan/types.js';
import { S3WebsiteConstruct } from './s3_website_construct.js';
import { runFrontDoor } from './door_hooks.js';
import { s3WebsiteDoor } from './s3_website_door.js';

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

  it('grants anonymous s3:ListBucket so a missing key 404s → error document (SPA deep-link fallback)', () => {
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Allow', Principal: { AWS: '*' }, Action: 's3:ListBucket' }),
        ]),
      },
    });
  });

  it('publishes the static dir without pruning and EXCLUDES the .blocks-sandbox placeholder (real config wins)', () => {
    // The build ships a placeholder .blocks-sandbox/config.json; the real config
    // is written by the separate BlocksConfigDeployment. The website deploy must
    // not upload the placeholder or prune the real config.
    t.hasResourceProperties('Custom::CDKBucketDeployment', { Prune: false, Exclude: ['.blocks-sandbox/*'] });
  });
});

describe('s3WebsiteDoor — hooks + check', () => {
  it('is the s3-website service and defines only the core hooks (no feature hooks)', () => {
    assert.equal(s3WebsiteDoor.service, 's3-website');
    for (const h of ['sameOriginApi', 'customDomain', 'waf', 'restrictGeo', 'accessLogs', 'alarms'] as const) {
      assert.equal(s3WebsiteDoor[h], undefined, `${h} must be absent`);
    }
  });
  it('renders a pure-static SPA plan (no atomicity opt-in needed)', () => {
    const app = new App();
    const stack = new Stack(app, 'S2', { env: { account: '111111111111', region: 'us-west-2' } });
    assert.ok(runFrontDoor(stack, spaPlan, s3WebsiteDoor, { staticDir }).handle.url);
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
    assert.throws(() => runFrontDoor(stack, ssrPlan, s3WebsiteDoor, { staticDir }), /RunServerRender/);
  });
});
