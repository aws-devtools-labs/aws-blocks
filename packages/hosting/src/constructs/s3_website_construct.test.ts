import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { HostingPlan } from '../plan/types.js';
import { S3WebsiteConstruct } from './s3_website_construct.js';
import { buildFrontDoor } from './custom_door.js';
import { buildDoorInput } from './door_input.js';
import { s3WebsiteDoor } from './s3_website_door.js';

const staticDir = mkdtempSync(join(tmpdir(), 's3site-'));
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>x</title>');

const spaPlan: HostingPlan = {
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

  it('publishes the static dir, pruning what the build no longer ships, and EXCLUDES the .blocks-sandbox placeholder', () => {
    // The build ships a placeholder .blocks-sandbox/config.json; the real config
    // is written by the separate BlocksConfigDeployment. An excluded key is
    // outside the deployment's filter, so prune never deletes the real config.
    t.hasResourceProperties('Custom::CDKBucketDeployment', {
      Prune: true,
      Exclude: Match.arrayWith(['.blocks-sandbox/*', '*.html', '**/*.html']),
    });
    for (const d of Object.values(t.findResources('Custom::CDKBucketDeployment'))) {
      assert.equal(d.Properties.Prune, true);
    }
  });

  it('serves HTML always revalidated, hashed assets immutable, the rest revalidated', () => {
    const s = new Stack(new App(), 'Tiers', { env: { account: '111111111111', region: 'us-west-2' } });
    new S3WebsiteConstruct(s, 'Site', { plan: spaPlan, staticDir, immutablePaths: ['assets/*'] });
    const deployments = Object.values(Template.fromStack(s).findResources('Custom::CDKBucketDeployment'));
    const byInclude = (glob: string) => deployments.find((d) => (d.Properties.Include ?? []).includes(glob));
    assert.deepEqual(byInclude('*.html')?.Properties.SystemMetadata, { 'cache-control': 'no-cache, no-store, must-revalidate' });
    assert.deepEqual(byInclude('assets/*')?.Properties.SystemMetadata, { 'cache-control': 'public, max-age=31536000, immutable' });
    const rest = deployments.find((d) => !d.Properties.Include);
    assert.deepEqual(rest?.Properties.SystemMetadata, { 'cache-control': 'public, max-age=0, must-revalidate' });
  });

  it("a multi-page site's error document is its 404.html when it ships one, else index.html", () => {
    const mpa: HostingPlan = { ...spaPlan, policies: { ...spaPlan.policies, spaFallback: false } };
    const errorDocOf = (dir: string) => {
      const s = new Stack(new App(), 'Err', { env: { account: '111111111111', region: 'us-west-2' } });
      new S3WebsiteConstruct(s, 'Site', { plan: mpa, staticDir: dir });
      return Object.values(Template.fromStack(s).findResources('AWS::S3::Bucket'))[0]?.Properties.WebsiteConfiguration.ErrorDocument;
    };
    assert.equal(errorDocOf(staticDir), 'index.html');
    const with404 = mkdtempSync(join(tmpdir(), 's3site404-'));
    writeFileSync(join(with404, 'index.html'), '<!doctype html>');
    writeFileSync(join(with404, '404.html'), '<!doctype html>');
    assert.equal(errorDocOf(with404), '404.html');
  });
});

describe('s3WebsiteDoor — free-form build', () => {
  const buildSite = (stack: Stack, plan: HostingPlan) => {
    const input = buildDoorInput({ plan, bucket: new Bucket(stack, 'Assets'), staticDir });
    return buildFrontDoor(stack, s3WebsiteDoor, { ...input, plan }, { wiringCheck: false }).result;
  };
  it('is the s3-website service, defined by one build function', () => {
    assert.equal(s3WebsiteDoor.service, 's3-website');
    assert.equal(typeof s3WebsiteDoor.build, 'function');
  });
  it('renders a pure-static SPA plan and hands back its public website bucket', () => {
    const app = new App();
    const stack = new Stack(app, 'S2', { env: { account: '111111111111', region: 'us-west-2' } });
    const res = buildSite(stack, spaPlan);
    assert.ok(res.url);
    assert.equal(res.originHandle.protocol, 'http');
    // The host of `http://<bucket>.s3-website…` (index 1 of a split on '://').
    const buckets = Template.fromStack(stack).findResources('AWS::S3::Bucket');
    const website = Object.keys(buckets).find((id) => buckets[id].Properties?.WebsiteConfiguration);
    assert.deepEqual(stack.resolve(res.originHandle.domainName), {
      'Fn::Select': [1, { 'Fn::Split': ['://', { 'Fn::GetAtt': [website, 'WebsiteURL'] }] }],
    });
    assert.ok(res.publicBucket, 'exposes the public website bucket');
  });
  it('rejects an SSR plan (a website bucket cannot run a server)', () => {
    const app = new App();
    const stack = new Stack(app, 'S3', { env: { account: '111111111111', region: 'us-west-2' } });
    const ssrPlan: HostingPlan = {
      ...spaPlan,
      origins: [
        { id: 'blocks-s3', kind: 'static' },
        { id: 'blocks-server', kind: 'server' },
      ],
      policies: { ...spaPlan.policies, hasServer: true },
    };
    assert.throws(() => buildSite(stack, ssrPlan), /UnsupportedFrontDoorError|renders on a server/);
  });
});
