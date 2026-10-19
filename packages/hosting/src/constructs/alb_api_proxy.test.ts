// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The ALB door's API forwarder (same-origin `/aws-blocks/*` and raw routes):
 * it relays the request to the backend and the response back in the ALB
 * multi-value shape, so several `Set-Cookie` headers survive, and applies the
 * app's header rules to a successful response, as the CloudFront door does at
 * the edge. The generated source runs against an in-memory `node:https` stub.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { generateAlbApiProxyCode } from './alb_api_proxy.js';

type Upstream = { status: number; headers: Record<string, string | string[]>; body: string };
type Seen = { method?: string; path?: string; headers?: Record<string, string>; body?: string };
type AlbResponse = {
  statusCode: number;
  multiValueHeaders: Record<string, string[]>;
  body: string;
  isBase64Encoded: boolean;
};

const load = (code: string, upstream: Upstream, seen: Seen) => {
  const https = {
    request(opts: { method: string; path: string; headers: Record<string, string> }, cb: (res: unknown) => void) {
      seen.method = opts.method;
      seen.path = opts.path;
      seen.headers = opts.headers;
      const chunks: Buffer[] = [];
      const req = new EventEmitter() as EventEmitter & { write: (b: Buffer) => void; end: () => void };
      req.write = (b) => chunks.push(Buffer.from(b));
      req.end = () => {
        seen.body = Buffer.concat(chunks).toString('utf8');
        const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
        res.statusCode = upstream.status;
        res.statusMessage = 'OK';
        res.headers = upstream.headers;
        cb(res);
        res.emit('data', Buffer.from(upstream.body));
        res.emit('end');
      };
      return req;
    },
  };
  const mod: { exports: { handler?: (e: unknown) => Promise<AlbResponse> } } = { exports: {} };
  const fakeRequire = (id: string) => {
    if (id === 'node:https') return https;
    throw new Error(`unexpected require: ${id}`);
  };
  const env = { env: { API_GW_BASE: 'https://abc.execute-api.us-west-2.amazonaws.com/prod' } };
  new Function('require', 'exports', 'module', 'process', code)(fakeRequire, mod.exports, mod, env);
  if (!mod.exports.handler) throw new Error('no handler');
  return mod.exports.handler;
};

const event = (path: string) => ({
  requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:us-west-2:111111111111:targetgroup/x/y' } },
  httpMethod: 'POST',
  path,
  multiValueQueryStringParameters: { a: ['1'] },
  multiValueHeaders: { 'content-type': ['application/json'], host: ['alb.example.com'], cookie: ['s=1'] },
  body: Buffer.from('{"x":1}').toString('base64'),
  isBase64Encoded: true,
});

const HEADER_RULES: Array<{ pattern: string; headers: Record<string, string> }> = [
  { pattern: '/aws-blocks/*', headers: { 'X-Api-Rule': 'api' } },
  { pattern: '/hooks/*', headers: { 'X-Hook-Rule': 'hook' } },
];

describe('ALB API forwarder', () => {
  it('relays method, path, query and body to the backend stage, and every Set-Cookie back', async () => {
    const seen: Seen = {};
    const handler = load(
      generateAlbApiProxyCode(),
      { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] }, body: '{"ok":true}' },
      seen,
    );
    const res = await handler(event('/aws-blocks/api'));
    assert.equal(seen.method, 'POST');
    assert.equal(seen.path, '/prod/aws-blocks/api?a=1');
    assert.equal(seen.body, '{"x":1}');
    assert.equal(seen.headers?.host, 'abc.execute-api.us-west-2.amazonaws.com');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.multiValueHeaders['set-cookie'], ['a=1', 'b=2']);
  });

  it("applies the app's matching header rules to a successful response", async () => {
    const handler = load(
      generateAlbApiProxyCode({ headers: HEADER_RULES }),
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' },
      {},
    );
    const api = await handler(event('/aws-blocks/api'));
    assert.deepEqual(api.multiValueHeaders['x-api-rule'], ['api']);
    assert.equal(api.multiValueHeaders['x-hook-rule'], undefined);
    const hook = await handler(event('/hooks/door-probe'));
    assert.deepEqual(hook.multiValueHeaders['x-hook-rule'], ['hook']);
  });

  it('leaves an error response as the backend sent it (as at the edge)', async () => {
    const handler = load(
      generateAlbApiProxyCode({ headers: HEADER_RULES }),
      { status: 401, headers: { 'content-type': 'application/json' }, body: '{"error":"unauthorized"}' },
      {},
    );
    const res = await handler(event('/aws-blocks/api'));
    assert.equal(res.statusCode, 401);
    assert.equal(res.multiValueHeaders['x-api-rule'], undefined);
  });
});
