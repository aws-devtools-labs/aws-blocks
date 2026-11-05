// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Characterization of the local dev server's HTTP responses: one real HTTP
// request per response path (JSON-RPC, RawRoute, preflight, the runtime config
// endpoint, the frontend fallthrough), compared against the exact response the
// dev server produces — status, header names, Set-Cookie values, and body —
// plus the request log lines those requests write.
//
// To re-capture after an intentional change, run with CHARACTERIZE_OUT=<file>
// and paste the written object over EXPECTED.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Host header every case sends, so request URLs don't depend on the bound port. */
const HOST = 'localhost:3000';

/** Response headers that vary per connection or run, left out of the comparison. */
const VOLATILE_HEADERS = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length']);

function importPath(file: string): string {
  return join(__dirname, '..', file).replace(/\\/g, '/');
}

const BACKEND = `
import { ApiError, RawRoute, blocksError } from '${importPath('index.js')}';
import { requestCookies, requestClientUserAgent } from '${importPath('request-context.js')}';

const scope = { id: 'characterization' };
function route(id, method, path, handler) {
  new RawRoute(scope, id, { method, path, handler });
}

export const api = (ctx) => ({
  async echo(msg) {
    return {
      msg,
      url: ctx.request.url.href,
      cookie: requestCookies.getStore() ?? null,
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
    const err = new Error('boom: internal detail');
    Object.defineProperty(err, 'cause', { value: 'driver detail', enumerable: false });
    throw err;
  },
  async conflict() {
    throw new ApiError('Already exists', 409);
  },
  async branded() {
    throw blocksError('ThingNotFound', 'no such thing');
  },
  async signOutAndFail() {
    ctx.response.headers.append('Set-Cookie', 'live=1; Path=/');
    ctx.response.headers.append('Set-Cookie', 'gone=; Path=/; Max-Age=0');
    throw new ApiError('Unauthorized', 401);
  },
  async signInAndFail() {
    ctx.response.headers.append('Set-Cookie', 'sid=live; Path=/');
    throw new ApiError('Unavailable', 503);
  },
  async body() {
    return { text: await ctx.request.text(), hasStream: ctx.request.body !== null };
  },
  async headers() {
    return { auth: ctx.request.headers.get('authorization'), host: ctx.request.headers.get('host') };
  },
  async secret(input) {
    return { password: input.password };
  },
});

export const notApi = 42;

route('users', 'GET', '/users/{id}', async (ctx) => {
  ctx.response.status = 201;
  ctx.response.headers.set('X-Route', 'users');
  ctx.response.headers.append('Set-Cookie', 'r1=1; Path=/');
  ctx.response.headers.append('Set-Cookie', 'r2=2; Path=/');
  ctx.response.send({
    id: ctx.request.params.id,
    q: ctx.request.url.searchParams.getAll('q'),
    cookie: requestCookies.getStore() ?? null,
  });
});
route('text', 'GET', '/text', async (ctx) => {
  ctx.response.headers.set('Content-Type', 'text/plain; charset=utf-8');
  ctx.response.send('plain text');
});
route('boom', 'GET', '/boom', async () => {
  throw new Error('raw boom: internal detail');
});
route('cookieBoom', 'GET', '/cookie-boom', async (ctx) => {
  ctx.response.headers.append('Set-Cookie', 'sid=live; Path=/');
  throw new Error('raw cookie boom: internal detail');
});
route('textBoom', 'GET', '/text-boom', async (ctx) => {
  ctx.response.headers.set('Content-Type', 'text/plain');
  throw new ApiError('Teapot', 418);
});
route('echoBody', 'POST', '/echo-body', async (ctx) => {
  ctx.response.send({ text: await ctx.request.text(), json: await ctx.request.json() });
});
route('url', 'GET', '/url', async (ctx) => {
  ctx.response.send({ url: ctx.request.url.href });
});
route('files', 'GET', '/files/*', async (ctx) => {
  ctx.response.send({ rest: ctx.request.params['*'] });
});
route('threeSegments', 'POST', '/{tenant}/{area}/{id}', async (ctx) => {
  ctx.response.send({ rawRoute: ctx.request.params });
});
route('empty', 'GET', '/empty', async (ctx) => {
  ctx.response.status = 204;
  ctx.response.send('');
});
route('badStatus', 'GET', '/bad-status', async (ctx) => {
  ctx.response.status = 99;
  ctx.response.send('never');
});
`;

function rpcBody(method: string, params: unknown = [], id: number | string = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id });
}

interface Case {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

function rpc(body: string, headers: Record<string, string> = {}, path = '/aws-blocks/api'): Case {
  return { method: 'POST', path, headers: { 'Content-Type': 'application/json', ...headers }, body };
}

const CASES: Record<string, Case> = {
  'rpc success with a localhost origin, cookie and client user agent': rpc(rpcBody('api.echo', ['hi']), {
    Origin: 'http://localhost:5173',
    Cookie: 'sid=abc',
    'X-Blocks-User-Agent': 'aws-blocks-swift/1.2.3',
  }),
  'rpc success without origin': rpc(rpcBody('api.echo', ['hi'])),
  'rpc success with a non-localhost origin': rpc(rpcBody('api.echo', ['hi']), { Origin: 'https://evil.example' }),
  'rpc success with an unvalidated client user agent': rpc(rpcBody('api.echo', ['hi']), {
    'X-Blocks-User-Agent': 'not a token',
  }),
  'rpc sets two cookies, a custom header and a status': rpc(rpcBody('api.login')),
  'rpc ctx.response.send overrides the return value': rpc(rpcBody('api.override')),
  'rpc method throws a plain error': rpc(rpcBody('api.fail')),
  'rpc method throws an ApiError': rpc(rpcBody('api.conflict')),
  'rpc method throws a branded blocks error': rpc(rpcBody('api.branded')),
  'rpc method sets cookies then throws': rpc(rpcBody('api.signOutAndFail')),
  'rpc method sets a live cookie then throws': rpc(rpcBody('api.signInAndFail')),
  'rpc unknown namespace': rpc(rpcBody('nope.echo')),
  'rpc non-dispatchable export': rpc(rpcBody('notApi.echo')),
  'rpc unknown method': rpc(rpcBody('api.nope')),
  'rpc Object.prototype method': rpc(rpcBody('api.toString')),
  'rpc invalid JSON body': rpc('{not json'),
  'rpc empty body': rpc(''),
  'rpc invalid JSON-RPC request': rpc(JSON.stringify({ jsonrpc: '1.0', method: 'api.echo', id: 1 })),
  'rpc named params': rpc(rpcBody('api.echo', { msg: 'named' }, 'req-7')),
  'rpc per-namespace path': rpc(rpcBody('api.echo', ['hi']), {}, '/aws-blocks/api/api'),
  'rpc per-namespace path that mismatches the body': rpc(rpcBody('api.echo', ['hi']), {}, '/aws-blocks/api/other'),
  'rpc body reaches the handler': rpc(rpcBody('api.body')),
  'rpc request headers reach the handler': rpc(rpcBody('api.headers'), { Authorization: 'Bearer t' }),
  'rpc redacts secrets from its log lines': rpc(rpcBody('api.secret', [{ password: 'hunter2-secret' }])),
  'GET on the RPC path': { method: 'GET', path: '/aws-blocks/api' },
  'GET on a per-namespace RPC path': { method: 'GET', path: '/aws-blocks/api/api' },
  'preflight on the RPC path': {
    method: 'OPTIONS',
    path: '/aws-blocks/api',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
  },
  'preflight on a frontend path': { method: 'OPTIONS', path: '/some/page', headers: { Origin: 'https://evil.example' } },
  'raw route with params, repeated query, cookies and status': {
    method: 'GET',
    path: '/users/42?q=a&q=b',
    headers: { Origin: 'http://127.0.0.1:3000', Cookie: 'sid=abc' },
  },
  'raw route text body': { method: 'GET', path: '/text' },
  'raw route throws': { method: 'GET', path: '/boom' },
  'raw route sets a cookie then throws': { method: 'GET', path: '/cookie-boom' },
  'raw route sets a content type then throws an ApiError': { method: 'GET', path: '/text-boom' },
  'raw route POST body': {
    method: 'POST',
    path: '/echo-body',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x: 1 }),
  },
  'raw route url with an unnormalized query': { method: 'GET', path: '/url?b=x%20y&a=1&flag' },
  'raw route wildcard': { method: 'GET', path: '/files/a/b/c.txt' },
  'raw route three-segment POST': { method: 'POST', path: '/t/area/9', body: '' },
  'raw route empty 204': { method: 'GET', path: '/empty' },
  'raw route out-of-range status': { method: 'GET', path: '/bad-status' },
  'raw route with the wrong method falls through to the frontend': { method: 'DELETE', path: '/users/1' },
  'unknown path falls through to the frontend': { method: 'GET', path: '/not-a-route' },
  'runtime config endpoint': { method: 'GET', path: '/.blocks-sandbox/config.json' },
};

const EXPECTED: Record<string, unknown> = {
  "rpc success with a localhost origin, cookie and client user agent": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:5173",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"hi\",\"url\":\"http://localhost:3000/aws-blocks/api\",\"cookie\":null,\"userAgent\":null},\"id\":1}"
  },
  "rpc success without origin": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"hi\",\"url\":\"http://localhost:3000/aws-blocks/api\",\"cookie\":null,\"userAgent\":null},\"id\":1}"
  },
  "rpc success with a non-localhost origin": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"hi\",\"url\":\"http://localhost:3000/aws-blocks/api\",\"cookie\":null,\"userAgent\":null},\"id\":1}"
  },
  "rpc success with an unvalidated client user agent": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"hi\",\"url\":\"http://localhost:3000/aws-blocks/api\",\"cookie\":null,\"userAgent\":null},\"id\":1}"
  },
  "rpc sets two cookies, a custom header and a status": {
    "status": 201,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin",
      "x-custom": "yes"
    },
    "cookies": [
      "a=1; Path=/",
      "b=2; Path=/"
    ],
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"ok\":true},\"id\":1}"
  },
  "rpc ctx.response.send overrides the return value": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"replaced\":true},\"id\":1}"
  },
  "rpc method throws a plain error": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":500,\"message\":\"Internal error\"},\"id\":1}"
  },
  "rpc method throws an ApiError": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":409,\"message\":\"Already exists\"},\"id\":1}"
  },
  "rpc method throws a branded blocks error": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":500,\"message\":\"ThingNotFound: no such thing\",\"data\":{\"name\":\"ThingNotFound\"}},\"id\":1}"
  },
  "rpc method sets cookies then throws": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [
      "gone=; Path=/; Max-Age=0"
    ],
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":401,\"message\":\"Unauthorized\"},\"id\":1}"
  },
  "rpc method sets a live cookie then throws": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":503,\"message\":\"Unavailable\"},\"id\":1}"
  },
  "rpc unknown namespace": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32601,\"message\":\"Method not found: API 'nope' not found. Available: api\"},\"id\":1}"
  },
  "rpc non-dispatchable export": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32601,\"message\":\"Method not found: API 'notApi' not found. Available: api\"},\"id\":1}"
  },
  "rpc unknown method": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32601,\"message\":\"Method not found: 'nope' on API 'api'\"},\"id\":1}"
  },
  "rpc Object.prototype method": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32601,\"message\":\"Method not found: 'toString' on API 'api'\"},\"id\":1}"
  },
  "rpc invalid JSON body": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32700,\"message\":\"Parse error\"},\"id\":null}"
  },
  "rpc empty body": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32600,\"message\":\"Invalid Request: expected JSON-RPC 2.0 — {\\\"jsonrpc\\\":\\\"2.0\\\",\\\"method\\\":\\\"namespace.method\\\",\\\"params\\\":[...],\\\"id\\\":1}\",\"data\":{\"name\":\"InvalidRequest\"}},\"id\":null}"
  },
  "rpc invalid JSON-RPC request": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32600,\"message\":\"Invalid Request: expected JSON-RPC 2.0 — {\\\"jsonrpc\\\":\\\"2.0\\\",\\\"method\\\":\\\"namespace.method\\\",\\\"params\\\":[...],\\\"id\\\":1}\",\"data\":{\"name\":\"InvalidRequest\"}},\"id\":1}"
  },
  "rpc named params": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"named\",\"url\":\"http://localhost:3000/aws-blocks/api\",\"cookie\":null,\"userAgent\":null},\"id\":\"req-7\"}"
  },
  "rpc per-namespace path": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"msg\":\"hi\",\"url\":\"http://localhost:3000/aws-blocks/api/api\",\"cookie\":null,\"userAgent\":null},\"id\":1}"
  },
  "rpc per-namespace path that mismatches the body": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32600,\"message\":\"Invalid Request: the path addresses namespace \\\"other\\\" but the method is in namespace \\\"api\\\"\",\"data\":{\"name\":\"InvalidRequest\"}},\"id\":1}"
  },
  "rpc body reaches the handler": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"text\":\"{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"method\\\":\\\"api.body\\\",\\\"params\\\":[],\\\"id\\\":1}\",\"hasStream\":true},\"id\":1}"
  },
  "rpc request headers reach the handler": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"auth\":\"Bearer t\",\"host\":\"localhost:3000\"},\"id\":1}"
  },
  "rpc redacts secrets from its log lines": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"jsonrpc\":\"2.0\",\"result\":{\"password\":\"hunter2-secret\"},\"id\":1}"
  },
  "GET on the RPC path": {
    "status": 404,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"error\":\"The AWS Blocks JSON-RPC API expects POST, not GET.\",\"expected\":{\"method\":\"POST\",\"path\":\"/aws-blocks/api\"}}"
  },
  "GET on a per-namespace RPC path": {
    "status": 404,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"error\":\"The AWS Blocks JSON-RPC API expects POST, not GET.\",\"expected\":{\"method\":\"POST\",\"path\":\"/aws-blocks/api/api\"}}"
  },
  "preflight on the RPC path": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:5173",
      "access-control-max-age": "7200",
      "vary": "Origin"
    },
    "cookies": [],
    "body": ""
  },
  "preflight on a frontend path": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "vary": "Origin"
    },
    "cookies": [],
    "body": ""
  },
  "raw route with params, repeated query, cookies and status": {
    "status": 201,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://127.0.0.1:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin",
      "x-route": "users"
    },
    "cookies": [
      "r1=1; Path=/",
      "r2=2; Path=/"
    ],
    "body": "{\"id\":\"42\",\"q\":[\"a\",\"b\"],\"cookie\":null}"
  },
  "raw route text body": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "text/plain; charset=utf-8",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "plain text"
  },
  "raw route throws": {
    "status": 500,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"error\":\"Internal error\"}"
  },
  "raw route sets a cookie then throws": {
    "status": 500,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [
      "sid=live; Path=/"
    ],
    "body": "{\"error\":\"Internal error\"}"
  },
  "raw route sets a content type then throws an ApiError": {
    "status": 418,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"error\":\"Teapot\"}"
  },
  "raw route POST body": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"text\":\"{\\\"x\\\":1}\",\"json\":{\"x\":1}}"
  },
  "raw route url with an unnormalized query": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"url\":\"http://localhost:3000/url?b=x%20y&a=1&flag\"}"
  },
  "raw route wildcard": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"rest\":\"a/b/c.txt\"}"
  },
  "raw route three-segment POST": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"rawRoute\":{\"tenant\":\"t\",\"area\":\"area\",\"id\":\"9\"}}"
  },
  "raw route empty 204": {
    "status": 204,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": ""
  },
  "raw route out-of-range status": {
    "status": 500,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"error\":\"Internal error\"}"
  },
  "raw route with the wrong method falls through to the frontend": {
    "status": 404,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "vary": "Origin"
    },
    "cookies": [],
    "body": ""
  },
  "unknown path falls through to the frontend": {
    "status": 404,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "vary": "Origin"
    },
    "cookies": [],
    "body": ""
  },
  "runtime config endpoint": {
    "status": 200,
    "headers": {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization, x-blocks-user-agent",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-max-age": "7200",
      "cache-control": "no-store",
      "content-type": "application/json",
      "vary": "Origin"
    },
    "cookies": [],
    "body": "{\"apiUrl\":\"http://localhost:<port>/aws-blocks/api\",\"environment\":\"local\"}"
  }
};

interface Captured {
  status: number;
  headers: Record<string, string>;
  cookies: string[];
  body: string;
}

function send(port: number, c: Case): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: c.method, path: c.path, headers: { Host: HOST, ...c.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (VOLATILE_HEADERS.has(name) || name === 'set-cookie' || value === undefined) continue;
            headers[name] = Array.isArray(value) ? value.join(', ') : value;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))),
            cookies: res.headers['set-cookie'] ?? [],
            body: Buffer.concat(chunks).toString('utf-8').replaceAll(String(port), '<port>'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(c.body);
  });
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  return port;
}

describe('dev server HTTP characterization', () => {
  let devProcess: ChildProcess | undefined;
  let tempDir = '';
  let port = 0;
  const output = { stdout: '', stderr: '' };
  const actual: Record<string, Captured> = {};

  before(async () => {
    port = await getAvailablePort();
    tempDir = join(tmpdir(), `dev-characterization-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'backend.ts'), BACKEND);
    writeFileSync(join(tempDir, 'run-dev.ts'), `
import { startDevServer } from ${JSON.stringify(join(__dirname, 'dev-server.js'))};
startDevServer(${JSON.stringify({ backendPath: join(tempDir, 'backend.ts'), port, typegen: false })});
`);
    const tsxBin = join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
    const env: NodeJS.ProcessEnv = { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1' };
    // Log at the default level so the request log lines are part of the characterization.
    delete env.BLOCKS_DEV_QUIET;
    delete env.BLOCKS_LOG_LEVEL;
    delete env.BLOCKS_API_URL;
    delete env.CORS_ALLOWED_ORIGINS;
    delete env.CORS_HOSTING_ORIGINS;
    devProcess = spawn(tsxBin, [join(tempDir, 'run-dev.ts')], { cwd: tempDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    devProcess.stdout?.on('data', chunk => { output.stdout += chunk.toString(); });
    devProcess.stderr?.on('data', chunk => { output.stderr += chunk.toString(); });

    const deadline = Date.now() + 20_000;
    while (!output.stdout.includes('AWS Blocks local server running')) {
      if (Date.now() > deadline || devProcess.exitCode !== null) {
        assert.fail(`Dev server did not start\nstdout: ${output.stdout}\nstderr: ${output.stderr}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Sequential, so each request's log lines land in order.
    for (const [name, c] of Object.entries(CASES)) actual[name] = await send(port, c);
  });

  after(async () => {
    if (devProcess && devProcess.exitCode === null) {
      devProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          devProcess?.kill('SIGKILL');
          resolve();
        }, 2_000);
        devProcess?.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  const captureFile = process.env.CHARACTERIZE_OUT;
  if (captureFile) {
    it('captures the current responses', () => {
      writeFileSync(captureFile, JSON.stringify(actual, null, 2));
    });
    return;
  }

  for (const name of Object.keys(CASES)) {
    it(name, () => {
      assert.ok(name in EXPECTED, `no expected response captured for "${name}"`);
      assert.deepStrictEqual(actual[name], EXPECTED[name]);
    });
  }

  it('writes the request log lines', () => {
    const { stdout, stderr } = output;
    assert.match(stdout, /\[rpc-in\] \{"jsonrpc":"2\.0","method":"api\.echo"/);
    assert.match(stdout, /\[rpc-call\] api\.echo \["hi"\]/);
    assert.match(stdout, /\[rpc-ok\] api\.echo \{"msg":"hi"/);
    assert.match(stdout, /\[rpc-in\] \{not json/);
    assert.match(stdout, /\[rpc-out parse-error\] \{"jsonrpc":"2\.0","error":\{"code":-32700/);
    assert.match(stdout, /\[rpc-err\] api\.fail Error - boom: internal detail\n {2}cause: driver detail\nError: boom: internal detail\n {4}at /);
    assert.match(stdout, /\[rpc-err\] api\.conflict ApiError - Already exists/);
    assert.match(stderr, /RawRoute Error: Error - raw boom: internal detail\nError: raw boom: internal detail\n {4}at /);
    assert.ok(!stdout.includes('hunter2-secret') && !stderr.includes('hunter2-secret'), 'a secret reached the log');
    // Handler errors are logged only through the lines above.
    assert.ok(!stderr.includes('RPC Error:'), stderr);
    assert.ok(!stderr.includes('No RawRoute matched'), stderr);
    assert.ok(!stderr.includes('[CORS]'), stderr);
  });
});
