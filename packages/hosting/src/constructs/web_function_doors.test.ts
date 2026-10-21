// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `compute.type: 'web-function'` × every front door.
 *
 * A Web Function is reachable only through the CloudFront door (its server
 * origin). Every other door routes to Lambda functions (an ALB target, an API
 * Gateway integration, a `DoorInput` server origin), so a Web Function behind
 * one would deploy with no traffic reaching it. Those combinations fail synth
 * with `UnsupportedComputeFrontDoorError`, before anything deploys.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import { Template } from 'aws-cdk-lib/assertions';
import type { DeployManifest } from '../manifest/types.js';
import { cf } from './cf_helpers.js';
import { defineFrontDoor } from './front_door.js';
import { HostingConstruct, type HostingConstructProps } from './hosting_construct.js';

const API_URL = 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api';

const customCloudFrontDoor = defineFrontDoor({
  service: 'my-cdn',
  build(scope, { origins }) {
    const dist = new Distribution(scope, 'Cdn', { defaultBehavior: { origin: cf.origin(origins.assets) } });
    return { url: `https://${dist.distributionDomainName}` };
  },
});

describe("compute.type 'web-function' × every front door", () => {
  let tmpDir: string;
  let bundleDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-wf-doors-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
    bundleDir = path.join(tmpDir, 'server');
    fs.mkdirSync(bundleDir);
    fs.writeFileSync(path.join(bundleDir, 'index.mjs'), 'export const handler = async () => ({});');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const ssrManifest = (): DeployManifest => ({
    version: 1,
    buildId: 'wf1',
    compute: {
      server: { type: 'http-server', bundle: bundleDir, entrypoint: 'index.mjs', port: 3000, placement: 'regional' },
    },
    staticAssets: { directory: tmpDir },
    routes: [
      { pattern: '/_astro/*', target: 'static' },
      { pattern: '/*', target: 'server' },
    ],
  });

  const synth = (frontDoor: HostingConstructProps['frontDoor'], extra: Partial<HostingConstructProps> = {}) => {
    const stack = new Stack(new App(), 'S', { env: { account: '111111111111', region: 'us-west-2' } });
    const hosting = new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(),
      compute: { type: 'web-function' },
      frontDoor,
      ...extra,
    });
    return { t: Template.fromStack(stack), hosting };
  };

  it('CloudFront (default): the Web Function is the server origin', () => {
    const { hosting } = synth(undefined);
    assert.equal(hosting.computeWebFunctions.size, 1);
    assert.equal(hosting.frontDoor.service, 'cloudfront');
  });

  it("CloudFront ('cloudfront'): the Web Function is the server origin", () => {
    const { hosting } = synth('cloudfront');
    assert.equal(hosting.computeWebFunctions.size, 1);
  });

  const unsupported: Array<[string, HostingConstructProps['frontDoor'], Partial<HostingConstructProps>?]> = [
    ['alb', { kind: 'alb' }, { backendApi: { url: API_URL } }],
    ['apiGateway (http)', { kind: 'apiGateway' }, { backendApi: { url: API_URL } }],
    [
      'apiGateway (rest)',
      { kind: 'apiGateway', api: 'rest' },
      {
        backendApi: { url: API_URL },
        domain: { domainName: 'app.example.com', hostedZoneId: 'Z1234567890ABC', hostedZone: 'example.com' },
      },
    ],
    ['custom', { kind: 'custom', door: customCloudFrontDoor }, { backendApi: { url: API_URL } }],
    ['none', 'none'],
  ];
  for (const [label, frontDoor, extra] of unsupported) {
    it(`${label}: fails synth with UnsupportedComputeFrontDoorError`, () => {
      assert.throws(
        () => synth(frontDoor, extra),
        (e: Error) =>
          e.name === 'UnsupportedComputeFrontDoorError' &&
          /web-function/.test(e.message) &&
          /CloudFront/.test(e.message),
      );
    });
  }
});

describe('HostingConstruct — middleware runs only behind the CloudFront door', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-mw-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
    fs.mkdirSync(path.join(tmpDir, 'mw'));
    fs.writeFileSync(path.join(tmpDir, 'mw', 'index.mjs'), 'export const handler = async (e) => e;');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const manifest = (): DeployManifest => ({
    version: 1,
    buildId: 'mw1',
    compute: {},
    staticAssets: { directory: tmpDir, spaFallback: true },
    routes: [{ pattern: '/*', target: 'static' }],
    middleware: { bundle: path.join(tmpDir, 'mw'), handler: 'index.handler', matchers: ['/*'] },
  });
  const synth = (frontDoor: HostingConstructProps['frontDoor']) =>
    new HostingConstruct(new Stack(new App(), 'Mw', { env: { account: '111111111111', region: 'us-east-1' } }), 'Hosting', {
      manifest: manifest(),
      frontDoor,
      skipRegionValidation: true,
    });

  for (const [label, frontDoor] of [
    ['alb', { kind: 'alb' }],
    ['apiGateway', { kind: 'apiGateway' }],
    ['stacked', { kind: 'stackedRouter' }],
    ['none', 'none'],
  ] as const) {
    it(`${label}: fails synth with MiddlewareNeedsCloudFrontDoorError`, () => {
      assert.throws(
        () => synth(frontDoor),
        (e: Error) => e.name === 'MiddlewareNeedsCloudFrontDoorError' && e.message.includes(`'${label}'`),
      );
    });
  }

  it('CloudFront: builds (the middleware runs at the edge)', () => {
    assert.doesNotThrow(() => synth(undefined));
  });
});
