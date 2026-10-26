// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The built-in default 404 page behind every front door.
 *
 * A multi-page static site (no server, no SPA fallback) that ships no
 * `404.html` and sets no `errorPages.notFound` gets AWS Blocks' default
 * "404 — Page Not Found" page at HTTP 404 for a missing path. The CloudFront
 * door wires it as a CloudFront error response; the ALB and API Gateway doors
 * serve it from their asset proxy; a bring-your-own door receives it as
 * `DoorInput.app.errorPages.notFound`. Same precedence on every door: the
 * app's `errorPages.notFound`, then the framework's `errorPages[404]`, then
 * the default. An SPA keeps its `index.html` fallback, and a site with a
 * server keeps its own 404.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import { NOT_FOUND_PAGE_KEY } from '../defaults.js';
import type { DeployManifest } from '../manifest/types.js';
import { cf } from './cf_helpers.js';
import { cloudFrontEdgeDoor } from './cloudfront_edge_door.js';
import { buildFrontDoor } from './custom_door.js';
import { customErrorResponses } from './error_responses.js';
import { type DoorInput, defineFrontDoor } from './front_door.js';
import { HostingConstruct, type HostingConstructProps } from './hosting_construct.js';

const DOMAIN = { domainName: 'app.example.com', hostedZone: 'example.com', hostedZoneId: 'Z1234567890ABC' };

describe('the default 404 page behind every front door', () => {
  let tmpDir: string;
  let bundleDir: string;
  let userNotFound: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-default-404-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
    fs.mkdirSync(path.join(tmpDir, 'about'));
    fs.writeFileSync(path.join(tmpDir, 'about', 'index.html'), '<html></html>');
    bundleDir = path.join(tmpDir, 'server');
    fs.mkdirSync(bundleDir);
    fs.writeFileSync(path.join(bundleDir, 'run.sh'), '#!/bin/sh\nnode server.js');
    userNotFound = path.join(tmpDir, 'my-404.html');
    fs.writeFileSync(userNotFound, '<!DOCTYPE html><html><body>my 404</body></html>');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  /** A multi-page static site (Astro `output: 'static'` without a 404 page). */
  const mpa = (over: Partial<DeployManifest> = {}): DeployManifest => ({
    version: 1,
    buildId: 'd404',
    compute: {},
    staticAssets: { directory: tmpDir, spaFallback: false },
    routes: [{ pattern: '/*', target: 'static' }],
    ...over,
  });

  const synth = (
    manifest: DeployManifest,
    frontDoor: HostingConstructProps['frontDoor'],
    extra: Partial<HostingConstructProps> = {},
  ) => {
    const stack = new Stack(new App(), 'D404', { env: { account: '111111111111', region: 'us-west-2' } });
    const hosting = new HostingConstruct(stack, 'Hosting', { manifest, frontDoor, ...extra });
    return { t: Template.fromStack(stack), hosting };
  };
  /** Whether the default page is uploaded to the build prefix. */
  const uploadsDefaultPage = (t: Template): boolean =>
    Object.keys(t.findResources('Custom::CDKBucketDeployment')).some((id) => id.includes('DefaultNotFoundPageDeployment'));
  /** Every distribution's error responses, as [status, page path]. */
  const errorResponsePaths = (t: Template): Array<[number, unknown]> =>
    Object.values(t.findResources('AWS::CloudFront::Distribution')).flatMap((d) =>
      ((d.Properties.DistributionConfig.CustomErrorResponses ?? []) as Array<{ ErrorCode: number; ResponsePagePath: unknown }>).map(
        (r): [number, unknown] => [r.ErrorCode, r.ResponsePagePath],
      ),
    );
  /** The inline asset-proxy source (the function that carries the app's rules). */
  const assetProxySource = (t: Template): string => {
    const fn = Object.values(t.findResources('AWS::Lambda::Function')).find((f) =>
      String(f.Properties.Code?.ZipFile ?? '').includes('NOT_FOUND_PAGE'),
    );
    assert.ok(fn, 'an asset proxy');
    return String(fn.Properties.Code.ZipFile);
  };

  const regionalDoors: Array<[string, HostingConstructProps['frontDoor'], Partial<HostingConstructProps>]> = [
    ['API Gateway (HTTP)', { kind: 'apiGateway' }, {}],
    ['API Gateway (REST)', { kind: 'apiGateway', api: 'rest' }, { domain: DOMAIN }],
    ['ALB', { kind: 'alb' }, {}],
  ];

  for (const [label, frontDoor, extra] of regionalDoors) {
    it(`${label}: uploads the default page and the asset proxy serves it on a miss`, () => {
      const { t } = synth(mpa(), frontDoor, extra);
      assert.ok(uploadsDefaultPage(t), 'the _not_found.html upload');
      assert.match(assetProxySource(t), new RegExp(`NOT_FOUND_PAGE = "${NOT_FOUND_PAGE_KEY.replace('.', '\\.')}"`));
    });
  }

  it('a bring-your-own door gets the default page as DoorInput.app.errorPages.notFound (and it is uploaded)', () => {
    const seen: { input?: DoorInput } = {};
    const door = defineFrontDoor({
      service: 'my-cdn',
      build(scope, input) {
        seen.input = input;
        const pages = cf.errorPages(input.app.errorPages, input.origins);
        const dist = new Distribution(scope, 'Cdn', {
          defaultBehavior: { origin: cf.origin(input.origins.assets) },
          errorResponses: pages.errorResponses,
          additionalBehaviors: pages.behaviors,
        });
        return { url: `https://${dist.distributionDomainName}` };
      },
    });
    const { t } = synth(mpa(), { kind: 'custom', door });
    assert.deepEqual(seen.input?.app.errorPages, { notFound: NOT_FOUND_PAGE_KEY });
    assert.ok(uploadsDefaultPage(t));
    // `cf.errorPages` serves the page at its own key (the default page is not `404.html`).
    assert.deepEqual(errorResponsePaths(t), [[404, `/${NOT_FOUND_PAGE_KEY}`]]);
    // ...and the 404 can fire: CloudFront may list the bucket, so S3 answers a miss with 404, not 403.
    const listGrant = Object.values(t.findResources('AWS::S3::BucketPolicy'))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<{ Effect: string; Principal?: { Service?: string }; Action: string | string[] }>)
      .some((s) => s.Effect === 'Allow' && s.Principal?.Service === 'cloudfront.amazonaws.com' && [s.Action].flat().includes('s3:ListBucket'));
    assert.ok(listGrant, 'CloudFront can list the bucket, so a miss is a 404 from S3, not a 403');
  });

  it("the stacked door's router uploads the default page and the edge serves it at its key", () => {
    const stack = new Stack(new App(), 'D404Stacked', { env: { account: '111111111111', region: 'us-west-2' } });
    const hosting = new HostingConstruct(stack, 'Hosting', { manifest: mpa(), frontDoor: { kind: 'stackedRouter' } });
    assert.deepEqual(hosting.doorInput.app.errorPages, { notFound: NOT_FOUND_PAGE_KEY });
    // The edge, built on the router's DoorInput as `@aws-blocks/core`'s `Hosting` builds it.
    const router = hosting.frontDoor;
    buildFrontDoor(
      stack,
      cloudFrontEdgeDoor,
      { ...hosting.doorInput, upstream: { service: router.service, url: router.url, originHandle: router.originHandle } },
      { wiringCheck: false },
    );
    const t = Template.fromStack(stack);
    assert.ok(uploadsDefaultPage(t));
    assert.deepEqual(errorResponsePaths(t).find(([code]) => code === 404), [404, `/builds/d404/${NOT_FOUND_PAGE_KEY}`]);
  });

  it('error pages are served at their own keys behind the edge (stacked) and cf.errorPages', () => {
    const pages = { notFound: NOT_FOUND_PAGE_KEY, serverError: 'errors/500.html' };
    const paths = customErrorResponses(pages, { pathPrefix: '/builds/b1', hasCompute: false, pageKeys: true }).map((r) => [
      r.httpStatus,
      r.responsePagePath,
    ]);
    assert.deepEqual(paths[0], [404, `/builds/b1/${NOT_FOUND_PAGE_KEY}`]);
    assert.deepEqual(paths[1], [500, '/builds/b1/errors/500.html']);
    // The built-in CloudFront door uploads the app's files as 404.html / 500.html.
    assert.equal(customErrorResponses({ notFound: '/abs/my-404.html' }, { pathPrefix: '/builds/b1', hasCompute: false })[0]?.responsePagePath, '/builds/b1/404.html');
  });

  it('the CloudFront door still uploads it (unchanged)', () => {
    assert.ok(uploadsDefaultPage(synth(mpa(), undefined).t));
  });

  it('the CloudFront door maps each error code once when the site ships a 500 page but no 404 page', () => {
    fs.writeFileSync(path.join(tmpDir, '500.html'), '<html>500</html>');
    const { t } = synth(mpa({ errorPages: { 500: '/500.html' } }), undefined);
    const paths = errorResponsePaths(t);
    const codes = paths.map(([code]) => code);
    assert.deepEqual(codes, [...new Set(codes)], `one error response per code: ${JSON.stringify(paths)}`);
    assert.deepEqual(paths.find(([code]) => code === 403), [403, `/builds/d404/${NOT_FOUND_PAGE_KEY}`]);
    assert.deepEqual(paths.find(([code]) => code === 500), [500, '/builds/d404/500.html']);
  });

  // Routing falls back to index.html only for an explicit `spaFallback: true`
  // (`plan/hosting-plan.ts`), so a manifest that leaves it unset (a custom
  // adapter, a hand-written manifest) is a multi-page site on every door.
  for (const [label, frontDoor, extra] of [['CloudFront', undefined, {}], ...regionalDoors] as const) {
    it(`${label}: a manifest without spaFallback is routed as multi-page, so it gets the default page`, () => {
      const { t } = synth(mpa({ staticAssets: { directory: tmpDir } }), frontDoor, extra);
      assert.ok(uploadsDefaultPage(t));
    });
  }

  // One decision, from the manifest, on every door: an image optimizer is not
  // a server (it never answers a page miss), so it doesn't turn the page off.
  for (const [label, frontDoor, extra] of [['CloudFront', undefined, {}], ...regionalDoors] as const) {
    it(`${label}: a static site with an image optimizer (and no image route) still gets the default page`, () => {
      const { t } = synth(mpa({ imageOptimization: { bundle: bundleDir, handler: 'index.handler', formats: ['image/webp'], sizes: [640] } }), frontDoor, extra);
      assert.ok(uploadsDefaultPage(t));
    });
  }

  describe('no default page where the site has its own answer for a miss', () => {
    const cases: Array<[string, () => DeployManifest, Partial<HostingConstructProps>]> = [
      ['an SPA (index.html fallback)', () => mpa({ staticAssets: { directory: tmpDir, spaFallback: true } }), {}],
      [
        'a site with a server',
        () =>
          mpa({
            compute: { server: { type: 'http-server', bundle: bundleDir, entrypoint: 'run.sh', port: 3000, placement: 'regional' } },
            routes: [{ pattern: '/*', target: 'server' }],
          }),
        {},
      ],
      ["the framework's 404.html", () => mpa({ errorPages: { 404: '/404.html' } }), {}],
      ["the app's errorPages.notFound", () => mpa(), { errorPages: { notFound: '' } }],
    ];
    const doors: Array<[string, HostingConstructProps['frontDoor'], Partial<HostingConstructProps>]> = [
      ['CloudFront', undefined, {}],
      ...regionalDoors,
    ];
    for (const [what, manifest, caseExtra] of cases) {
      for (const [label, frontDoor, doorExtra] of doors) {
        it(`${what} — ${label}`, () => {
          const extra = { ...doorExtra, ...caseExtra };
          if (extra.errorPages) extra.errorPages = { notFound: userNotFound };
          const { t } = synth(manifest(), frontDoor, extra);
          assert.equal(uploadsDefaultPage(t), false);
          if (frontDoor !== undefined) {
            const fn = Object.values(t.findResources('AWS::Lambda::Function')).find((f) =>
              String(f.Properties.Code?.ZipFile ?? '').includes('NOT_FOUND_PAGE'),
            );
            if (fn) assert.doesNotMatch(String(fn.Properties.Code.ZipFile), /_not_found\.html/);
          }
        });
      }
    }
  });
});
