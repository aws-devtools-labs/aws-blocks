/**
 * `HostingConstruct` with a bring-your-own front door (`frontDoor: { kind:
 * 'custom', door }`): what the door receives, what AWS Blocks does with what it
 * hands back, and the routes/API wiring check.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { DeployManifest } from '../manifest/types.js';
import { cf } from './cf_helpers.js';
import { type DoorInput, defineFrontDoor, type FrontDoorResult } from './front_door.js';
import { HostingConstruct, type HostingConstructProps } from './hosting_construct.js';

const API_URL = 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api';

describe('HostingConstruct — bring-your-own front door', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-byo-'));
    fs.mkdirSync(path.join(tmpDir, 'assets'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(tmpDir, 'assets', 'app.js'), 'x');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const manifest = (): DeployManifest => ({
    version: 1,
    buildId: 'byo1',
    compute: {},
    staticAssets: { directory: tmpDir, spaFallback: true },
    routes: [
      { pattern: '/assets/*', target: 'static' },
      { pattern: '/*', target: 'static' },
    ],
  });

  /** The doc's free-form door: CloudFront, the helpers, WAF + domain from features, a post-upload purge. */
  const docDoor = (seen: { input?: DoorInput } = {}) =>
    defineFrontDoor({
      service: 'my-cdn',
      build(scope, input) {
        seen.input = input;
        const { app, origins, features } = input;
        const dist = new Distribution(scope, 'Cdn', {
          defaultBehavior: { origin: cf.origin(origins.server ?? origins.assets) },
          additionalBehaviors: { ...cf.behaviors(app.routes), ...cf.apiBehaviors(origins.api) },
          webAclId: features.waf?.webAclArn,
        });
        return {
          url: `https://${dist.distributionDomainName}`,
          onUpload: ({ uploads }) => cf.invalidate(dist, { after: uploads }),
        };
      },
    });

  const synth = (frontDoor: HostingConstructProps['frontDoor'], extra: Partial<HostingConstructProps> = {}) => {
    const stack = new Stack(new App(), 'Byo', { env: { account: '111111111111', region: 'us-east-1' } });
    const hosting = new HostingConstruct(stack, 'Hosting', { manifest: manifest(), frontDoor, ...extra });
    return { stack, hosting };
  };

  it('hands the door a DoorInput: routes joined to origins, API paths incl. raw routes, features only when asked', () => {
    const seen: { input?: DoorInput } = {};
    synth(
      { kind: 'custom', door: docDoor(seen) },
      {
        backendApi: { url: API_URL, paths: ['/webhooks/*'] },
        waf: { enabled: true, webAclArn: 'arn:aws:wafv2:us-east-1:111111111111:global/webacl/x/1' },
      },
    );
    const input = seen.input;
    assert.ok(input, 'build was called');
    assert.equal(input.app.buildId, 'byo1');
    assert.equal(input.app.spaFallback, true);
    // The static catch-all is the door's default; the specific routes are listed.
    assert.deepEqual(
      input.app.routes.map((r) => [r.pattern, r.origin.kind]),
      [['/assets/*', 'assets']],
    );
    assert.equal(input.app.routes[0]?.origin, input.origins.assets, 'a route points at the origin object itself');
    assert.equal(input.origins.assets.prefix, 'builds/byo1/');
    assert.equal(input.origins.assets.sourceDir, tmpDir);
    assert.equal(input.origins.server, undefined, 'a static app has no server origin');
    assert.deepEqual(input.origins.api?.paths, ['/aws-blocks/*', '/webhooks/*']);
    assert.deepEqual(Object.keys(input.features), ['waf', 'skewProtection'], 'only the WAF (and default skew protection) asked for');
    assert.equal(input.features.waf?.webAclArn, 'arn:aws:wafv2:us-east-1:111111111111:global/webacl/x/1');
  });

  it("uses the door's url as the deploy's address", () => {
    const { stack, hosting } = synth({ kind: 'custom', door: docDoor() }, { backendApi: { url: API_URL } });
    assert.equal(hosting.distributionUrl, hosting.frontDoor.url);
    assert.equal(hosting.frontDoor.service, 'my-cdn');
    assert.deepEqual(stack.resolve(hosting.distributionUrl), {
      'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [Object.keys(Template.fromStack(stack).findResources('AWS::CloudFront::Distribution'))[0], 'DomainName'] }]],
    });
    // A BYO door is not the built-in CloudFront door: `distribution` is not
    // available (typed as before for CloudFront deploys; throws here).
    assert.throws(() => hosting.distribution, (err: Error) => err.name === 'FrontDoorNotCloudFrontError');
    assert.throws(() => hosting.getResources().distribution, (err: Error) => err.name === 'FrontDoorNotCloudFrontError');
    assert.equal(hosting.getResources().distributionUrl, hosting.frontDoor.url);
  });

  it('a missing url fails synth (MissingFrontDoorUrlError) instead of deploying with no address', () => {
    const door = defineFrontDoor({
      service: 'forgetful',
      build(scope, { origins }) {
        new Distribution(scope, 'Cdn', { defaultBehavior: { origin: cf.origin(origins.assets) } });
        return {} as FrontDoorResult;
      },
    });
    assert.throws(() => synth({ kind: 'custom', door }), (err: Error) => err.name === 'MissingFrontDoorUrlError');
  });

  it('onUpload runs after the uploads are declared: the invalidation depends on every asset upload', () => {
    const { stack } = synth({ kind: 'custom', door: docDoor() }, { backendApi: { url: API_URL } });
    const t = Template.fromStack(stack).toJSON();
    const resources = t.Resources as Record<string, { Type: string; DependsOn?: string[] }>;
    const uploads = Object.entries(resources)
      .filter(([, r]) => r.Type === 'Custom::CDKBucketDeployment')
      .map(([id]) => id);
    assert.ok(uploads.length >= 2, 'the asset uploads exist');
    const [invalidationId, invalidation] =
      Object.entries(resources).find(([, r]) => r.Type === 'Custom::AWS') ?? [];
    assert.ok(invalidation && invalidationId, 'the door declared an invalidation');
    for (const upload of uploads) {
      assert.ok(invalidation.DependsOn?.includes(upload), `${invalidationId} must depend on ${upload}`);
    }
  });

  it('publicBucket: a door that serves from its own public bucket hands it back (config.json goes there)', () => {
    const door = defineFrontDoor({
      service: 'public-site',
      build(scope, { origins }) {
        const site = new Bucket(scope, 'Site', { websiteIndexDocument: 'index.html' });
        cf.recordWired(origins.assets); // publishes the build output itself
        return { url: `http://${site.bucketWebsiteDomainName}`, publicBucket: site };
      },
    });
    const { hosting } = synth({ kind: 'custom', door });
    assert.ok(hosting.websiteBucket, 'the public bucket is exposed for config.json');
    assert.equal(hosting.frontDoor.originHandle.protocol, 'http', 'derived from the http:// website url');
  });

  it('wiring check: an API app whose door proxies none of the API paths fails synth', () => {
    const door = defineFrontDoor({
      service: 'my-cdn',
      build(scope, { origins }) {
        const dist = new Distribution(scope, 'Cdn', { defaultBehavior: { origin: cf.origin(origins.assets) } });
        return { url: `https://${dist.distributionDomainName}` };
      },
    });
    assert.throws(
      () => synth({ kind: 'custom', door }, { backendApi: { url: API_URL } }),
      (err: Error) => err.name === 'UnsupportedFrontDoorError' && /ProxySameOriginApi/.test(err.message),
    );
  });

  it("wiring check escape hatch: `wiringCheck: false` accepts a door wired with raw CDK", () => {
    const door = defineFrontDoor({
      service: 'raw',
      build(scope, { origins }) {
        const dist = new Distribution(scope, 'Cdn', {
          defaultBehavior: { origin: S3BucketOrigin.withOriginAccessControl(origins.assets.bucket) },
        });
        return { url: `https://${dist.distributionDomainName}` };
      },
    });
    assert.throws(() => synth({ kind: 'custom', door }, { backendApi: { url: API_URL } }), /ServeStaticAsset/);
    assert.doesNotThrow(() => synth({ kind: 'custom', door, wiringCheck: false }, { backendApi: { url: API_URL } }));
  });

  it('runs no feature check: a door that ignores a requested custom domain and logging still synthesizes', () => {
    assert.doesNotThrow(() =>
      synth(
        { kind: 'custom', door: docDoor() },
        { backendApi: { url: API_URL }, domain: { domainName: 'app.example.com' }, logging: { enabled: true } },
      ),
    );
  });
});
