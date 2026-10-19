// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The regional doors serve static files through a Lambda asset proxy, which
 * answers with the whole file base64-encoded in its JSON response — so a file
 * is capped by the response limit of that path: 1 MB for an ALB Lambda
 * target, 6 MB for a Lambda behind API Gateway (Lambda's synchronous response
 * limit, under API Gateway's 10 MB payload limit). Synth lists every build
 * asset over the limit (`@aws-blocks/hosting:AssetExceedsProxyLimit`).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import type { DeployManifest } from '../manifest/types.js';
import { HostingConstruct, type HostingConstructProps } from './hosting_construct.js';

const API_URL = 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api';
const WARNING = '@aws-blocks/hosting:AssetExceedsProxyLimit';

describe('a build asset too large for the Lambda asset proxy is reported at synth', () => {
  let tmpDir: string;
  let bundleDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-proxy-limits-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
    fs.mkdirSync(path.join(tmpDir, 'assets'));
    fs.mkdirSync(path.join(tmpDir, 'downloads'));
    // 700 KB → 933 KB of base64: under the ALB's 1 MB.
    fs.writeFileSync(path.join(tmpDir, 'assets', 'small.js'), Buffer.alloc(700 * 1024, 1));
    // 800 KB → 1.07 MB of base64: over the ALB's 1 MB, under API Gateway's 6 MB.
    fs.writeFileSync(path.join(tmpDir, 'assets', 'vendor.js'), Buffer.alloc(800 * 1024, 1));
    // 5 MB → 6.7 MB of base64: over both.
    fs.writeFileSync(path.join(tmpDir, 'downloads', 'manual.pdf'), Buffer.alloc(5 * 1024 * 1024, 1));
    bundleDir = path.join(tmpDir, 'server');
    fs.mkdirSync(bundleDir);
    fs.writeFileSync(path.join(bundleDir, 'run.sh'), '#!/bin/sh\nnode server.js');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const spa = (): DeployManifest => ({
    version: 1,
    buildId: 'limits1',
    compute: {},
    staticAssets: { directory: tmpDir, spaFallback: true },
    routes: [{ pattern: '/*', target: 'static' }],
  });
  const ssr = (): DeployManifest => ({
    version: 1,
    buildId: 'limits2',
    compute: {
      server: { type: 'http-server', bundle: bundleDir, entrypoint: 'run.sh', port: 3000, placement: 'regional' },
    },
    staticAssets: { directory: tmpDir },
    routes: [
      { pattern: '/assets/*', target: 'static' },
      { pattern: '/*', target: 'server' },
    ],
  });
  const warnings = (manifest: DeployManifest, frontDoor: HostingConstructProps['frontDoor']): string[] => {
    const stack = new Stack(new App(), 'S', { env: { account: '111111111111', region: 'us-west-2' } });
    new HostingConstruct(stack, 'Hosting', { manifest, frontDoor });
    return Annotations.fromStack(stack)
      .findWarning('*', Match.stringLikeRegexp(WARNING))
      .map((w) => String(w.entry.data));
  };

  it('ALB: lists every asset whose base64 response exceeds 1 MB', () => {
    const found = warnings(spa(), { kind: 'alb', backendApiUrl: API_URL });
    assert.equal(found.length, 1);
    assert.match(found[0], /\/assets\/vendor\.js/);
    assert.match(found[0], /\/downloads\/manual\.pdf/);
    assert.doesNotMatch(found[0], /small\.js/);
    assert.match(found[0], /1 MB/);
  });

  it('API Gateway: uses its own (Lambda 6 MB) limit', () => {
    const found = warnings(spa(), { kind: 'apiGateway', backendApiUrl: API_URL });
    assert.equal(found.length, 1);
    assert.match(found[0], /\/downloads\/manual\.pdf/);
    assert.doesNotMatch(found[0], /vendor\.js/);
    assert.match(found[0], /6 MB/);
  });

  it('stacked router: files the edge serves from S3 are not listed', () => {
    // A SPA behind the stacked door is served from S3 entirely.
    assert.deepEqual(warnings(spa(), { kind: 'alb', backendApiUrl: API_URL, restrictToCloudFront: true }), []);
    // With a server, the static routes (`/assets/*`) come from S3; the rest go through the ALB.
    const found = warnings(ssr(), { kind: 'alb', backendApiUrl: API_URL, restrictToCloudFront: true });
    assert.equal(found.length, 1);
    assert.match(found[0], /\/downloads\/manual\.pdf/);
    assert.doesNotMatch(found[0], /vendor\.js/);
  });

  it('CloudFront: no warning (S3 serves the files directly)', () => {
    assert.deepEqual(warnings(spa(), undefined), []);
  });
});
