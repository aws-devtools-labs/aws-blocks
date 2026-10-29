// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Characterization of the Lambda handler's HTTP responses: one API Gateway REST
// event per response path (CORS, preflight, RawRoute, JSON-RPC, 404), compared
// against the exact envelope the handler produced before the transport-neutral
// dispatch core was extracted — status, header names and casing, Set-Cookie
// placement, and body.
//
// To re-capture after an intentional change, run with CHARACTERIZE_OUT=<file>
// and paste the written object over EXPECTED.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { createLambdaHandler, _resetCorsPatterns, requestCookies, requestClientUserAgent } from './lambda-handler.js';
import { registerRoute, clearRouteRegistry } from './raw-route.js';
import { ApiError } from './errors.js';
import type { BlocksContext } from './api.js';

const ALLOWED_ORIGIN = 'https://app.example.com';
const API_HOST = 'abc123.execute-api.us-west-2.amazonaws.com';

const backend = {
  api: (ctx: BlocksContext) => ({
    async echo(msg: string) {
      return {
        msg,
        url: ctx.request.url.href,
        cookie: requestCookies.getStore(),
        userAgent: requestClientUserAgent.getStore() ?? null,
      };
    },
    async login() {
      ctx.response.headers.append('Set-Cookie', 'a=1; Path=/');
      ctx.response.headers.append('Set-Cookie', 'b=2; Path=/');
      ctx.response.headers.set('X-Custom', 'yes');
      ctx.response.status = 201;
      return { ok: true };
    },
    async override() {
      ctx.response.send({ replaced: true });
      return 'ignored';
    },
    async fail() {
      throw new Error('boom: internal detail');
    },
    async conflict() {
      throw new ApiError('Already exists', 409);
    },
    async signOutAndFail() {
      ctx.response.headers.append('Set-Cookie', 'live=1; Path=/');
      ctx.response.headers.append('Set-Cookie', 'gone=; Path=/; Max-Age=0');
      throw new ApiError('Unauthorized', 401);
    },
    async body() {
      return { text: await ctx.request.text(), hasStream: ctx.request.body !== null };
    },
    async headers() {
      return { auth: ctx.request.headers.get('authorization'), host: ctx.request.headers.get('host') };
    },
  }),
  notApi: 42,
};

function registerRoutes() {
  registerRoute({
    method: 'GET',
    path: '/users/{id}',
    handler: async (ctx) => {
      ctx.response.status = 201;
      ctx.response.headers.set('X-Route', 'users');
      ctx.response.headers.append('Set-Cookie', 'r1=1; Path=/');
      ctx.response.headers.append('Set-Cookie', 'r2=2; Path=/');
      ctx.response.send({ id: ctx.request.params.id, q: ctx.request.url.searchParams.getAll('q'), cookie: requestCookies.getStore() });
    },
  });
  registerRoute({
    method: 'GET',
    path: '/text',
    handler: async (ctx) => {
      ctx.response.headers.set('Content-Type', 'text/plain; charset=utf-8');
      ctx.response.send('plain text');
    },
  });
  registerRoute({
    method: 'GET',
    path: '/boom',
    handler: async () => {
      throw new Error('raw boom: internal detail');
    },
  });
  registerRoute({
    method: 'POST',
    path: '/echo-body',
    handler: async (ctx) => {
      ctx.response.send({ text: await ctx.request.text(), json: await ctx.request.json() });
    },
  });
  registerRoute({
    method: 'GET',
    path: '/url',
    handler: async (ctx) => {
      ctx.response.send({ url: ctx.request.url.href });
    },
  });
  registerRoute({
    method: 'GET',
    path: '/files/*',
    handler: async (ctx) => {
      ctx.response.send({ rest: ctx.request.params['*'] });
    },
  });
  // Matches every three-segment POST, `/aws-blocks/api/<namespace>` included: the
  // per-namespace RPC cases below pin that the RPC subtree skips RawRoute matching.
  registerRoute({
    method: 'POST',
    path: '/{tenant}/{area}/{id}',
    handler: async (ctx) => {
      ctx.response.send({ rawRoute: ctx.request.params });
    },
  });
  registerRoute({
    method: 'GET',
    path: '/empty',
    handler: async (ctx) => {
      ctx.response.status = 204;
      ctx.response.send('');
    },
  });
}

function rpcBody(method: string, params: unknown = [], id: number | string = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id });
}

function rpcEvent(overrides: Record<string, any> = {}) {
  return {
    httpMethod: 'POST',
    path: '/aws-blocks/api',
    headers: { 'Content-Type': 'application/json', Host: API_HOST },
    body: rpcBody('api.echo', ['hi']),
    isBase64Encoded: false,
    requestContext: { stage: 'prod' },
    ...overrides,
  };
}

function getEvent(path: string, overrides: Record<string, any> = {}) {
  return {
    httpMethod: 'GET',
    path,
    headers: { Host: API_HOST },
    body: null,
    isBase64Encoded: false,
    requestContext: { stage: 'prod' },
    ...overrides,
  };
}

interface Case {
  /** `CORS_ALLOWED_ORIGINS` for the case; unset when omitted. */
  cors?: string;
  event: Record<string, any>;
}

const CASES: Record<string, Case> = {
  'rpc success with allowed origin, cookie and client user agent': {
    cors: 'https://app\\.example\\.com',
    event: rpcEvent({
      headers: {
        'Content-Type': 'application/json',
        Host: API_HOST,
        origin: ALLOWED_ORIGIN,
        cookie: 'sid=abc',
        'x-blocks-user-agent': 'aws-blocks-swift/1.2.3',
      },
    }),
  },
  'rpc success without origin': { event: rpcEvent() },
  'rpc success with no origin while an allowlist is configured': {
    cors: 'https://app\\.example\\.com',
    event: rpcEvent(),
  },
  'rpc success with an unvalidated client user agent': {
    event: rpcEvent({ headers: { Host: API_HOST, 'X-Blocks-User-Agent': 'not a token' } }),
  },
  'rpc mixed-case valid client user agent header': {
    event: rpcEvent({ headers: { Host: API_HOST, 'X-Blocks-User-Agent': 'aws-blocks-swift/1.2.3' } }),
  },
  'rpc mixed-case Cookie header': {
    event: rpcEvent({ headers: { Host: API_HOST, Cookie: 'Mixed=1' } }),
  },
  'rpc sets two cookies, a custom header and a status': { event: rpcEvent({ body: rpcBody('api.login') }) },
  'rpc ctx.response.send overrides the return value': { event: rpcEvent({ body: rpcBody('api.override') }) },
  'rpc method throws a plain error': { event: rpcEvent({ body: rpcBody('api.fail') }) },
  'rpc method throws an ApiError': { event: rpcEvent({ body: rpcBody('api.conflict') }) },
  'rpc method sets cookies then throws': { event: rpcEvent({ body: rpcBody('api.signOutAndFail') }) },
  'rpc unknown namespace': { event: rpcEvent({ body: rpcBody('nope.echo') }) },
  'rpc non-dispatchable export': { event: rpcEvent({ body: rpcBody('notApi.echo') }) },
  'rpc unknown method': { event: rpcEvent({ body: rpcBody('api.nope') }) },
  'rpc Object.prototype method': { event: rpcEvent({ body: rpcBody('api.toString') }) },
  'rpc invalid JSON body': { event: rpcEvent({ body: '{not json' }) },
  'rpc empty body': { event: rpcEvent({ body: null }) },
  'rpc named params': { event: rpcEvent({ body: rpcBody('api.echo', { msg: 'named' }, 'req-7') }) },
  'rpc per-namespace path': { event: rpcEvent({ path: '/aws-blocks/api/api' }) },
  'rpc per-namespace path that mismatches the body': { event: rpcEvent({ path: '/aws-blocks/api/other' }) },
  'rpc base64 body': {
    event: rpcEvent({ body: Buffer.from(rpcBody('api.body', ['ignored'])).toString('base64'), isBase64Encoded: true }),
  },
  'rpc request headers reach the handler': {
    event: rpcEvent({ body: rpcBody('api.headers'), headers: { Host: API_HOST, Authorization: 'Bearer t' } }),
  },
  'rpc url behind a loopback forwarded host': {
    event: rpcEvent({ headers: { Host: API_HOST, 'X-Forwarded-Host': 'localhost:3000' } }),
  },
  'rpc url ignores a non-loopback forwarded host': {
    event: rpcEvent({ headers: { Host: API_HOST, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' } }),
  },
  'cross-origin request from a disallowed origin': {
    cors: 'https://app\\.example\\.com',
    event: rpcEvent({ headers: { Host: API_HOST, Origin: 'https://evil.example' } }),
  },
  'preflight from an allowed origin': {
    cors: 'https://app\\.example\\.com',
    event: getEvent('/aws-blocks/api', { httpMethod: 'OPTIONS', headers: { Host: API_HOST, origin: ALLOWED_ORIGIN } }),
  },
  'preflight without an allowlist': {
    event: getEvent('/users/1', { httpMethod: 'OPTIONS', headers: { Host: API_HOST, origin: ALLOWED_ORIGIN } }),
  },
  'raw route with params, repeated query, cookies and status': {
    cors: 'https://app\\.example\\.com',
    event: getEvent('/users/42', {
      headers: { Host: API_HOST, origin: ALLOWED_ORIGIN, cookie: 'sid=abc' },
      queryStringParameters: { q: 'b' },
      multiValueQueryStringParameters: { q: ['a', 'b'] },
    }),
  },
  'raw route text body': { event: getEvent('/text') },
  'raw route throws': { event: getEvent('/boom') },
  'raw route POST body': {
    event: getEvent('/echo-body', { httpMethod: 'POST', body: JSON.stringify({ x: 1 }) }),
  },
  'raw route url with stage': { event: getEvent('/url', { queryStringParameters: { a: '1' } }) },
  'raw route url behind a loopback forwarded host': {
    event: getEvent('/url', { headers: { Host: API_HOST, 'x-forwarded-host': 'localhost:3000' } }),
  },
  'raw route wildcard': { event: getEvent('/files/a/b.txt') },
  'raw route trailing slash': { event: getEvent('/text/') },
  'raw route empty 204': { event: getEvent('/empty') },
  'raw route method mismatch is a 404': { event: getEvent('/text', { httpMethod: 'DELETE' }) },
  'unknown path': { event: getEvent('/missing') },
  'payload v2 rpc sets two cookies': {
    event: {
      version: '2.0',
      headers: { 'content-type': 'application/json', host: API_HOST },
      requestContext: { http: { method: 'POST', path: '/aws-blocks/api' } },
      body: rpcBody('api.login'),
      isBase64Encoded: false,
    },
  },
  'payload v2 rpc sets cookies then throws': {
    event: {
      version: '2.0',
      headers: { 'content-type': 'application/json', host: API_HOST },
      requestContext: { http: { method: 'POST', path: '/aws-blocks/api' } },
      body: rpcBody('api.signOutAndFail'),
      isBase64Encoded: false,
    },
  },
  'payload v2 raw route with cookies': {
    event: { version: '2.0', headers: { host: API_HOST }, requestContext: { http: { method: 'GET', path: '/users/7' } } },
  },
  'HTTP API v2-shaped event': {
    event: {
      headers: { host: API_HOST },
      requestContext: { http: { method: 'GET', path: '/text' } },
      rawQueryString: 'z=9',
    },
  },
};

async function run(c: Case): Promise<unknown> {
  clearRouteRegistry();
  _resetCorsPatterns();
  if (c.cors === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
  else process.env.CORS_ALLOWED_ORIGINS = c.cors;
  registerRoutes();
  const handler = createLambdaHandler(async () => backend);
  // Round-trip through JSON: that is what API Gateway receives.
  return JSON.parse(JSON.stringify(await handler(c.event)));
}

const EXPECTED: Record<string, unknown> = {
  "rpc success with allowed origin, cookie and client user agent": {
    "statusCode": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-origin": "https://app.example.com",
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"hi\",\"url\":\"https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api\",\"cookie\":\"sid=abc\",\"userAgent\":\"client/swift/1.2.3\"},\"id\":1}"
  },
  "rpc success without origin": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"hi\",\"url\":\"https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api\",\"cookie\":\"\",\"userAgent\":null},\"id\":1}"
  },
  "rpc success with no origin while an allowlist is configured": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"hi\",\"url\":\"https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api\",\"cookie\":\"\",\"userAgent\":null},\"id\":1}"
  },
  "rpc success with an unvalidated client user agent": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"hi\",\"url\":\"https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api\",\"cookie\":\"\",\"userAgent\":null},\"id\":1}"
  },
  "rpc mixed-case valid client user agent header": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"hi\",\"url\":\"https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api\",\"cookie\":\"\",\"userAgent\":\"client/swift/1.2.3\"},\"id\":1}"
  },
  "rpc mixed-case Cookie header": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"hi\",\"url\":\"https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api\",\"cookie\":\"Mixed=1\",\"userAgent\":null},\"id\":1}"
  },
  "rpc sets two cookies, a custom header and a status": {
    "statusCode": 201,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin",
      "x-custom": "yes"
    },
    "multiValueHeaders": {
      "Set-Cookie": [
        "a=1; Path=/",
        "b=2; Path=/"
      ]
    },
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"ok\":true},\"id\":1}"
  },
  "rpc ctx.response.send overrides the return value": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"replaced\":true},\"id\":1}"
  },
  "rpc method throws a plain error": {
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json",
      "Vary": "Origin",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":500,\"message\":\"Internal error\"},\"id\":1}"
  },
  "rpc method throws an ApiError": {
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json",
      "Vary": "Origin",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":409,\"message\":\"Already exists\"},\"id\":1}"
  },
  "rpc method sets cookies then throws": {
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json",
      "Vary": "Origin",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    "multiValueHeaders": {
      "Set-Cookie": [
        "gone=; Path=/; Max-Age=0"
      ]
    },
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":401,\"message\":\"Unauthorized\"},\"id\":1}"
  },
  "rpc unknown namespace": {
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json",
      "Vary": "Origin",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32601,\"message\":\"Method not found: API 'nope' not found\"},\"id\":1}"
  },
  "rpc non-dispatchable export": {
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json",
      "Vary": "Origin",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32601,\"message\":\"Method not found: API 'notApi' not found\"},\"id\":1}"
  },
  "rpc unknown method": {
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json",
      "Vary": "Origin",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32601,\"message\":\"Method not found: 'nope' on API 'api'\"},\"id\":1}"
  },
  "rpc Object.prototype method": {
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json",
      "Vary": "Origin",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32601,\"message\":\"Method not found: 'toString' on API 'api'\"},\"id\":1}"
  },
  "rpc invalid JSON body": {
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json",
      "Vary": "Origin",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32700,\"message\":\"Parse error\"},\"id\":null}"
  },
  "rpc empty body": {
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json",
      "Vary": "Origin",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32600,\"message\":\"Invalid Request: expected JSON-RPC 2.0 — {\\\"jsonrpc\\\":\\\"2.0\\\",\\\"method\\\":\\\"namespace.method\\\",\\\"params\\\":[...],\\\"id\\\":1}\",\"data\":{\"name\":\"InvalidRequest\"}},\"id\":null}"
  },
  "rpc named params": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"named\",\"url\":\"https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api\",\"cookie\":\"\",\"userAgent\":null},\"id\":\"req-7\"}"
  },
  "rpc per-namespace path": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"hi\",\"url\":\"https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api/api\",\"cookie\":\"\",\"userAgent\":null},\"id\":1}"
  },
  "rpc per-namespace path that mismatches the body": {
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json",
      "Vary": "Origin",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32600,\"message\":\"Invalid Request: the path addresses namespace \\\"other\\\" but the method is in namespace \\\"api\\\"\",\"data\":{\"name\":\"InvalidRequest\"}},\"id\":1}"
  },
  "rpc base64 body": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"text\":\"{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"method\\\":\\\"api.body\\\",\\\"params\\\":[\\\"ignored\\\"],\\\"id\\\":1}\",\"hasStream\":true},\"id\":1}"
  },
  "rpc request headers reach the handler": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"auth\":\"Bearer t\",\"host\":\"abc123.execute-api.us-west-2.amazonaws.com\"},\"id\":1}"
  },
  "rpc url behind a loopback forwarded host": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"hi\",\"url\":\"http://localhost:3000/aws-blocks/api\",\"cookie\":\"\",\"userAgent\":null},\"id\":1}"
  },
  "rpc url ignores a non-loopback forwarded host": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"hi\",\"url\":\"http://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api\",\"cookie\":\"\",\"userAgent\":null},\"id\":1}"
  },
  "cross-origin request from a disallowed origin": {
    "statusCode": 403,
    "headers": {
      "Content-Type": "application/json",
      "Vary": "Origin"
    },
    "body": "{\"error\":\"Forbidden: cross-origin request rejected\"}"
  },
  "preflight from an allowed origin": {
    "statusCode": 200,
    "headers": {
      "Vary": "Origin",
      "Access-Control-Allow-Origin": "https://app.example.com",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-blocks-user-agent",
      "Access-Control-Max-Age": "7200"
    },
    "body": ""
  },
  "preflight without an allowlist": {
    "statusCode": 200,
    "headers": {
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-blocks-user-agent",
      "Access-Control-Max-Age": "7200"
    },
    "body": ""
  },
  "raw route with params, repeated query, cookies and status": {
    "statusCode": 201,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-origin": "https://app.example.com",
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin",
      "x-route": "users"
    },
    "multiValueHeaders": {
      "Set-Cookie": [
        "r1=1; Path=/",
        "r2=2; Path=/"
      ]
    },
    "body": "{\"id\":\"42\",\"q\":[\"a\",\"b\"],\"cookie\":\"sid=abc\"}"
  },
  "raw route text body": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "text/plain; charset=utf-8",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "plain text"
  },
  "raw route throws": {
    "statusCode": 500,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"error\":\"Internal error\"}"
  },
  "raw route POST body": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"text\":\"{\\\"x\\\":1}\",\"json\":{\"x\":1}}"
  },
  "raw route url with stage": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"url\":\"https://abc123.execute-api.us-west-2.amazonaws.com/prod/url?a=1\"}"
  },
  "raw route url behind a loopback forwarded host": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"url\":\"http://localhost:3000/url\"}"
  },
  "raw route wildcard": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "{\"rest\":\"a/b.txt\"}"
  },
  "raw route trailing slash": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "text/plain; charset=utf-8",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "plain text"
  },
  "raw route empty 204": {
    "statusCode": 204,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": ""
  },
  "raw route method mismatch is a 404": {
    "statusCode": 404,
    "headers": {
      "Content-Type": "application/json",
      "Vary": "Origin"
    },
    "body": "{\"error\":\"Not Found\"}"
  },
  "unknown path": {
    "statusCode": 404,
    "headers": {
      "Content-Type": "application/json",
      "Vary": "Origin"
    },
    "body": "{\"error\":\"Not Found\"}"
  },
  "payload v2 rpc sets two cookies": {
    "statusCode": 201,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin",
      "x-custom": "yes"
    },
    "cookies": [
      "a=1; Path=/",
      "b=2; Path=/"
    ],
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"ok\":true},\"id\":1}"
  },
  "payload v2 rpc sets cookies then throws": {
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json",
      "Vary": "Origin",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    "cookies": [
      "gone=; Path=/; Max-Age=0"
    ],
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":401,\"message\":\"Unauthorized\"},\"id\":1}"
  },
  "payload v2 raw route with cookies": {
    "statusCode": 201,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "application/json",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin",
      "x-route": "users"
    },
    "cookies": [
      "r1=1; Path=/",
      "r2=2; Path=/"
    ],
    "body": "{\"id\":\"7\",\"q\":[],\"cookie\":\"\"}"
  },
  "HTTP API v2-shaped event": {
    "statusCode": 200,
    "headers": {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "content-type": "text/plain; charset=utf-8",
      "expires": "0",
      "pragma": "no-cache",
      "vary": "Origin"
    },
    "multiValueHeaders": {
      "Set-Cookie": []
    },
    "body": "plain text"
  }
};

describe('Lambda handler HTTP characterization', () => {
  let savedCors: string | undefined;
  beforeEach(() => {
    savedCors = process.env.CORS_ALLOWED_ORIGINS;
  });
  afterEach(() => {
    if (savedCors === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = savedCors;
    _resetCorsPatterns();
    clearRouteRegistry();
  });

  const captureFile = process.env.CHARACTERIZE_OUT;
  if (captureFile) {
    it('captures the current responses', async () => {
      const actual: Record<string, unknown> = {};
      for (const [name, c] of Object.entries(CASES)) actual[name] = await run(c);
      writeFileSync(captureFile, JSON.stringify(actual, null, 2));
    });
    return;
  }

  for (const [name, c] of Object.entries(CASES)) {
    it(name, async () => {
      assert.ok(name in EXPECTED, `no expected response captured for "${name}"`);
      assert.deepStrictEqual(await run(c), EXPECTED[name]);
    });
  }
});
