// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The forwarded-headers rewrite, run for real: the SSR cache guard module (which
 * carries it) is written to a temp directory and imported, so the tests run the
 * exact source the construct writes into the server bundle. Importing a module
 * with a trust patches `http.Server#emit` in this process.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import {
  CLOUDFRONT_FORWARDED_TRUST,
  DIRECT_FORWARDED_TRUST,
  type ForwardedHeadersTrust,
  STACKED_FORWARDED_TRUST,
  forwardedHeadersTrustFor,
} from './forwarded_headers.js';
import {
  SSR_CACHE_GUARD_FILE,
  SSR_CACHE_GUARD_HANDLER_FILE,
  generateSsrCacheGuardHandlerCode,
  generateSsrCacheGuardModule,
} from './ssr_cache_guard.js';

type Lookup = (name: string) => string | string[] | undefined;
type Values = Record<string, string | null>;
type HeaderMap = Record<string, string>;
type MultiHeaderMap = Record<string, string[]>;
type LambdaEvent = {
  headers?: HeaderMap;
  multiValueHeaders?: MultiHeaderMap;
  requestContext?: { identity?: { sourceIp: string }; http?: { sourceIp: string }; elb?: object };
};
type ForwardedModule = {
  forwardedValues: (get: Lookup) => Values | null;
  normalizeForwardedEvent: (event: LambdaEvent) => LambdaEvent;
};
type HandlerModule = { handler: (event: LambdaEvent) => Promise<unknown> };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forwarded-headers-'));
let counter = 0;
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const load = async <T>(
  forwarded: ForwardedHeadersTrust | undefined,
  extra: Record<string, string> = {},
  entry = SSR_CACHE_GUARD_FILE,
): Promise<T> => {
  const dir = path.join(tmpRoot, `m${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SSR_CACHE_GUARD_FILE), generateSsrCacheGuardModule({ forwarded }));
  for (const [name, code] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), code);
  return (await import(pathToFileURL(path.join(dir, entry)).href)) as T;
};

const lookup =
  (headers: Record<string, string>): Lookup =>
  (name) =>
    headers[name];

void describe('forwardedHeadersTrustFor', () => {
  void it('trusts what each built-in door sets, and nothing behind a bring-your-own door or none', () => {
    assert.deepEqual(forwardedHeadersTrustFor(undefined), CLOUDFRONT_FORWARDED_TRUST);
    assert.deepEqual(forwardedHeadersTrustFor('cloudfront'), CLOUDFRONT_FORWARDED_TRUST);
    assert.deepEqual(forwardedHeadersTrustFor('stackedRouter'), STACKED_FORWARDED_TRUST);
    assert.deepEqual(forwardedHeadersTrustFor('alb'), DIRECT_FORWARDED_TRUST);
    assert.deepEqual(forwardedHeadersTrustFor('apiGateway'), DIRECT_FORWARDED_TRUST);
    assert.equal(forwardedHeadersTrustFor('custom'), undefined);
    assert.equal(forwardedHeadersTrustFor('none'), undefined);
  });
});

void describe('forwardedValues', () => {
  void it('behind CloudFront: the router-set host, and the viewer CloudFront appended (2nd from the right)', async () => {
    const m = await load<ForwardedModule>(CLOUDFRONT_FORWARDED_TRUST);
    const values = m.forwardedValues(
      lookup({
        host: 'abc123.execute-api.us-west-2.amazonaws.com',
        'x-forwarded-host': 'd111111abcdef8.cloudfront.net',
        // The client sent the first two entries; CloudFront appended the viewer, the origin CloudFront.
        'x-forwarded-for': '6.6.6.6, 7.7.7.7, 203.0.113.10, 64.252.88.29',
        'x-forwarded-proto': 'https',
      }),
    );
    assert.deepEqual(values, {
      host: 'd111111abcdef8.cloudfront.net',
      'x-forwarded-host': 'd111111abcdef8.cloudfront.net',
      'x-forwarded-for': '203.0.113.10',
    });
  });

  void it('behind the stacked door: the viewer once (not the duplicate list) and the viewer scheme, not the plain-HTTP hop', async () => {
    const m = await load<ForwardedModule>(STACKED_FORWARDED_TRUST);
    const values = m.forwardedValues(
      lookup({
        host: 'internal-router-123.us-west-2.elb.amazonaws.com',
        'x-forwarded-host': 'd111111abcdef8.cloudfront.net',
        'x-forwarded-for': '6.6.6.6, 203.0.113.10, 203.0.113.10, 130.176.74.249',
        'x-forwarded-proto': 'http',
        'cloudfront-forwarded-proto': 'https',
      }),
    );
    assert.deepEqual(values, {
      host: 'd111111abcdef8.cloudfront.net',
      'x-forwarded-host': 'd111111abcdef8.cloudfront.net',
      'x-forwarded-for': '203.0.113.10',
      'x-forwarded-proto': 'https',
    });
  });

  void it('keeps the scheme the router saw when the edge sent none, or an unknown one', async () => {
    const m = await load<ForwardedModule>(STACKED_FORWARDED_TRUST);
    for (const proto of [undefined, 'gopher']) {
      const headers: Record<string, string> = { 'x-forwarded-proto': 'http' };
      if (proto) headers['cloudfront-forwarded-proto'] = proto;
      assert.equal(m.forwardedValues(lookup(headers))?.['x-forwarded-proto'], undefined);
    }
  });

  void it('behind the ALB and API Gateway doors: Host, and the right-most entry; a client x-forwarded-host is dropped', async () => {
    const m = await load<ForwardedModule>(DIRECT_FORWARDED_TRUST);
    assert.deepEqual(
      m.forwardedValues(
        lookup({ host: 'app.example.com', 'x-forwarded-host': 'evil.example', 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }),
      ),
      { host: 'app.example.com', 'x-forwarded-host': 'app.example.com', 'x-forwarded-for': '198.51.100.7' },
    );
    assert.deepEqual(m.forwardedValues(lookup({ 'x-forwarded-host': 'evil.example' })), {
      'x-forwarded-host': null,
      'x-forwarded-for': null,
    });
  });

  void it('uses the left-most entry when the list is shorter than the door hops (every entry is the door’s)', async () => {
    const m = await load<ForwardedModule>(CLOUDFRONT_FORWARDED_TRUST);
    assert.equal(m.forwardedValues(lookup({ 'x-forwarded-for': '203.0.113.10' }))?.['x-forwarded-for'], '203.0.113.10');
  });

  void it('rewrites nothing without a trust (a bring-your-own door, none)', async () => {
    const m = await load<ForwardedModule>(undefined);
    assert.equal(m.forwardedValues(lookup({ host: 'a', 'x-forwarded-for': '1.1.1.1' })), null);
    const event = { headers: { Host: 'a', 'X-Forwarded-For': '6.6.6.6, 1.1.1.1' } };
    assert.deepEqual(m.normalizeForwardedEvent(structuredClone(event)), event);
  });
});

void describe('normalizeForwardedEvent', () => {
  void it('rewrites a REST event whatever the header case, and its source IP', async () => {
    const m = await load<ForwardedModule>(CLOUDFRONT_FORWARDED_TRUST);
    const event = m.normalizeForwardedEvent({
      headers: {
        Host: 'abc123.execute-api.us-west-2.amazonaws.com',
        'X-Forwarded-Host': 'd111111abcdef8.cloudfront.net',
        'X-Forwarded-For': '6.6.6.6, 203.0.113.10, 64.252.88.29',
        'X-Forwarded-Proto': 'https',
      },
      multiValueHeaders: {
        Host: ['abc123.execute-api.us-west-2.amazonaws.com'],
        'X-Forwarded-Host': ['d111111abcdef8.cloudfront.net'],
        'X-Forwarded-For': ['6.6.6.6, 203.0.113.10, 64.252.88.29'],
      },
      requestContext: { identity: { sourceIp: '64.252.88.29' } },
    });
    assert.deepEqual(event.headers, {
      'X-Forwarded-Proto': 'https',
      host: 'd111111abcdef8.cloudfront.net',
      'x-forwarded-host': 'd111111abcdef8.cloudfront.net',
      'x-forwarded-for': '203.0.113.10',
    });
    assert.deepEqual(event.multiValueHeaders, {
      host: ['d111111abcdef8.cloudfront.net'],
      'x-forwarded-host': ['d111111abcdef8.cloudfront.net'],
      'x-forwarded-for': ['203.0.113.10'],
    });
    assert.equal(event.requestContext?.identity?.sourceIp, '203.0.113.10');
  });

  void it('sets an HTTP API event’s source IP', async () => {
    const m = await load<ForwardedModule>(DIRECT_FORWARDED_TRUST);
    const event = m.normalizeForwardedEvent({
      headers: { host: 'abc123.execute-api.us-west-2.amazonaws.com', 'x-forwarded-for': '6.6.6.6, 198.51.100.7' },
      requestContext: { http: { sourceIp: '198.51.100.7' } },
    });
    assert.equal(event.headers?.['x-forwarded-for'], '198.51.100.7');
    assert.equal(event.requestContext?.http?.sourceIp, '198.51.100.7');
  });

  void it('runs in the handler wrapper before the handler', async () => {
    const inner = `export const handler = async (event) => ({ statusCode: 200, body: JSON.stringify(event.headers) });\n`;
    const m = await load<HandlerModule>(
      CLOUDFRONT_FORWARDED_TRUST,
      { 'inner.mjs': inner, [SSR_CACHE_GUARD_HANDLER_FILE]: generateSsrCacheGuardHandlerCode('./inner.mjs') },
      SSR_CACHE_GUARD_HANDLER_FILE,
    );
    const result = (await m.handler({
      headers: { host: 'origin.example', 'x-forwarded-host': 'app.example.com', 'x-forwarded-for': '6.6.6.6, 203.0.113.10, 64.252.88.29' },
    })) as { body: string };
    assert.deepEqual(JSON.parse(result.body), {
      host: 'app.example.com',
      'x-forwarded-host': 'app.example.com',
      'x-forwarded-for': '203.0.113.10',
    });
  });
});

void describe('Node HTTP server', () => {
  void it('sees the rewritten headers and raw headers', async () => {
    await load<ForwardedModule>(STACKED_FORWARDED_TRUST);
    const seen: { headers?: http.IncomingHttpHeaders; raw?: string[] } = {};
    const server = http.createServer((req, res) => {
      seen.headers = req.headers;
      seen.raw = req.rawHeaders;
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/dynamic',
            headers: {
              host: 'internal-router-123.us-west-2.elb.amazonaws.com',
              'x-forwarded-host': 'd111111abcdef8.cloudfront.net',
              'x-forwarded-for': '6.6.6.6, 203.0.113.10, 203.0.113.10, 130.176.74.249',
              'x-forwarded-proto': 'http',
              'cloudfront-forwarded-proto': 'https',
            },
          },
          (res) => {
            res.resume();
            res.on('end', resolve);
          },
        );
        req.on('error', reject);
        req.end();
      });
    } finally {
      server.close();
    }
    assert.equal(seen.headers?.host, 'd111111abcdef8.cloudfront.net');
    assert.equal(seen.headers?.['x-forwarded-host'], 'd111111abcdef8.cloudfront.net');
    assert.equal(seen.headers?.['x-forwarded-for'], '203.0.113.10');
    assert.equal(seen.headers?.['x-forwarded-proto'], 'https');
    const raw = seen.raw ?? [];
    const pairs: [string, string][] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([String(raw[i]).toLowerCase(), String(raw[i + 1])]);
    assert.deepEqual(
      pairs.filter(([k]) => ['host', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto'].includes(k)),
      [
        ['host', 'd111111abcdef8.cloudfront.net'],
        ['x-forwarded-host', 'd111111abcdef8.cloudfront.net'],
        ['x-forwarded-for', '203.0.113.10'],
        ['x-forwarded-proto', 'https'],
      ],
    );
  });
});
