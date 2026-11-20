// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Astro adapter: the files an SSR build copies from `public/` into
// `dist/client/` are static routes, so every front door serves them from S3
// rather than through the SSR server.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { astroAdapter } from './astro.js';
import { buildHostingPlan } from '../plan/hosting-plan.js';
import { cloudFrontEdgeDoor } from '../constructs/cloudfront_edge_door.js';
import { buildFrontDoor } from '../constructs/custom_door.js';
import { buildDoorInput } from '../constructs/door_input.js';

/** An SSR Astro project with a finished build (`skipBuild: true`). */
const scaffold = (tmp: string, opts: { pages: string[]; client: Record<string, string> }): void => {
  fs.mkdirSync(path.join(tmp, 'node_modules', 'astro'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'node_modules', 'astro', 'package.json'), JSON.stringify({ name: 'astro', version: '5.0.0' }));
  fs.writeFileSync(path.join(tmp, 'astro.config.mjs'), "export default { output: 'server' };\n");
  const serverDir = path.join(tmp, 'dist', 'server');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'entry.mjs'), 'export const handler = () => {};');
  for (const [rel, body] of Object.entries(opts.client)) {
    const file = path.join(tmp, 'dist', 'client', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  for (const rel of opts.pages) {
    const file = path.join(tmp, 'src', 'pages', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '---\n---\n');
  }
};

const staticPatterns = (tmp: string): string[] =>
  astroAdapter({ projectDir: tmp, skipBuild: true })
    .routes.filter((r) => r.target === 'static')
    .map((r) => r.pattern);

void describe('astroAdapter — public files are static routes', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-public-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('routes each top-level public file, and a public folder no page lives under, to S3', () => {
    scaffold(tmp, {
      pages: ['index.astro', 'about.astro', 'blog/[slug].astro'],
      client: {
        'robots.txt': 'User-agent: *',
        'favicon.svg': '<svg/>',
        'big.bin': 'x',
        'terms.html': '<p>terms</p>',
        '_astro/app.abc123.js': '',
        'images/logo.png': '',
        'about/index.html': '<p>about</p>',
        'blog/cover.png': '',
      },
    });
    const patterns = staticPatterns(tmp);
    for (const p of ['/robots.txt', '/favicon.svg', '/big.bin', '/terms.html', '/_astro/*', '/images/*', '/about/*']) {
      assert.ok(patterns.includes(p), `${p} is a static route (got ${patterns.join(', ')})`);
    }
    // `blog/` holds a server-rendered page: a `/blog/*` static route would 404 `/blog/<slug>` from S3.
    assert.ok(!patterns.includes('/blog/*'), 'a folder a page lives under stays with the server');
    // The root index is the server's (or the catch-all's), never a file route.
    assert.ok(!patterns.includes('/index.html'));
    const routes = astroAdapter({ projectDir: tmp, skipBuild: true }).routes;
    assert.deepEqual(routes[routes.length - 1], { pattern: '/*', target: 'default' }, 'the SSR catch-all stays last');
  });

  it('keeps public folders with the server when a top-level dynamic page could match under them', () => {
    scaffold(tmp, {
      pages: ['index.astro', '[...slug].astro'],
      client: { 'robots.txt': '', 'images/logo.png': '' },
    });
    const patterns = staticPatterns(tmp);
    assert.ok(patterns.includes('/robots.txt'), 'a file is still a static route');
    assert.ok(!patterns.includes('/images/*'), 'the catch-all page may render under /images/');
  });

  it('keeps public folders with the server when there is no src/pages to check against', () => {
    scaffold(tmp, { pages: [], client: { 'robots.txt': '', 'images/logo.png': '' } });
    const patterns = staticPatterns(tmp);
    assert.ok(patterns.includes('/robots.txt'));
    assert.ok(!patterns.includes('/images/*'));
  });
});

void describe('astroAdapter — the stacked door edge serves public files from S3', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-public-edge-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('gives /robots.txt, /favicon.svg and /big.bin S3 behaviors; the pages stay on the router', () => {
    scaffold(tmp, {
      pages: ['index.astro', 'dynamic.astro'],
      client: { 'robots.txt': '', 'favicon.svg': '', 'big.bin': '', '_astro/app.abc123.js': '' },
    });
    const manifest = astroAdapter({ projectDir: tmp, skipBuild: true });
    const plan = buildHostingPlan({ manifest, buildId: 'b1', hasServer: true, hasImage: false });
    const stack = new Stack(new App(), 'AstroEdge', { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    const server = new LambdaFunction(stack, 'Server', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromInline('exports.handler=async()=>({})'),
    });
    const input = buildDoorInput({
      plan,
      bucket,
      staticDir: manifest.staticAssets.directory,
      server: { fn: server, streaming: false },
      api: { url: 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/cdk-blocks/api' },
    });
    buildFrontDoor(
      stack,
      cloudFrontEdgeDoor,
      {
        ...input,
        upstream: {
          service: 'alb',
          url: 'https://router.example.com',
          originHandle: { domainName: 'router.example.com', protocol: 'https', customHeaders: { 'x-blocks-origin-verify': 'v' } },
        },
      },
      { wiringCheck: false },
    );
    const dist = Object.values(Template.fromStack(stack).findResources('AWS::CloudFront::Distribution'))[0];
    const config = dist?.Properties.DistributionConfig as {
      DefaultCacheBehavior: { TargetOriginId: string };
      CacheBehaviors?: Array<{ PathPattern: string; TargetOriginId: string }>;
      Origins: Array<{ Id: string; S3OriginConfig?: unknown }>;
    };
    const s3Id = config.Origins.find((o) => o.S3OriginConfig)?.Id;
    assert.ok(s3Id, 'the edge has an S3 origin');
    const originOf = (pattern: string) => config.CacheBehaviors?.find((b) => b.PathPattern === pattern)?.TargetOriginId;
    for (const p of ['/robots.txt', '/favicon.svg', '/big.bin', '/_astro/*']) {
      assert.equal(originOf(p), s3Id, `${p} is served from S3 at the edge`);
    }
    assert.notEqual(config.DefaultCacheBehavior.TargetOriginId, s3Id, 'the pages go to the router');
  });
});
