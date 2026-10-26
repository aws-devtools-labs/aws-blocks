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
  });

  it('the CloudFront door still uploads it (unchanged)', () => {
    assert.ok(uploadsDefaultPage(synth(mpa(), undefined).t));
  });

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
