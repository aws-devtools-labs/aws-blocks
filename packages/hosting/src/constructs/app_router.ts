// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The app router: the one Lambda handler that serves a whole app when its
 * front door routes at the app (`defineFrontDoor({ routing: 'app', … })`).
 *
 * In that mode the door maps a hostname to ONE entry function
 * (`DoorInput.origins.entry`) and this handler runs the app's route table on
 * every request, with the same code the regional doors already ship:
 *
 * 1. the app's redirects (first match, wildcard tail spliced — `proxy_rules.ts`);
 * 2. an API path (`origins.api.paths`: `/aws-blocks/*` plus the backend's raw
 *    routes) → forwarded to the backend by the ALB door's API forwarder
 *    (`alb_api_proxy.ts`, run unchanged inside its own scope);
 * 3. the basePath (308 to it, as the CloudFront router does) and the Next.js
 *    `assetPrefix` (mapped into the basePath form);
 * 4. the route table (`plan/route-table.ts`, most-specific first, `/about/`
 *    also matching `/about`; unmatched → the server when there is one, else
 *    static):
 *    - `static` → the private bucket through the asset proxies' serving logic
 *      (`asset_proxy_core.ts`: SPA fallback, directory index, 304s, gzip,
 *      error pages, security headers, header rules);
 *    - `image` → the image function (invoked with a payload 2.0 event), or,
 *      when there is none, the asset proxies' image fallback (the source,
 *      unoptimized);
 *    - `server` → the framework: a native Lambda handler module (Next.js
 *      through OpenNext, Nitro `aws-lambda`) called in-process with a payload
 *      2.0 event, or an HTTP server (the Lambda Web Adapter frameworks: Astro,
 *      SvelteKit, Nitro `node-server`) started as a child process on its local
 *      port and reached over HTTP;
 * 5. server and image responses get the app's header rules (status below
 *    400) and its error pages (a 404 or 500 with a page configured is
 *    replaced by it, as the CloudFront door's custom error responses do);
 *    every response gets the baseline security headers when it doesn't set
 *    them itself.
 *
 * It accepts the events of an ALB Lambda target, an API Gateway REST API
 * (payload 1.0), an HTTP API and a Lambda Function URL (payload 2.0), and
 * answers in the matching shape: an ALB response with `multiValueHeaders`
 * when the event had them (a target group with multi-value headers on), else
 * single `headers`; a REST response with both; a 2.0 response with `cookies`.
 * A text body travels as UTF-8 when it round-trips, so the ALB's 1 MB response
 * limit is not cut by base64. An event that is none of these (a scheduled
 * warmup) reaches the native server handler unchanged.
 *
 * The generated module is CommonJS (the asset-serving code `require`s the AWS
 * SDK the Node.js runtime provides): the router Lambda of a static app runs
 * it as inline code, and a server bundle gets it as {@link APP_ROUTER_FILE}
 * next to the framework's handler, with {@link APP_ROUTER_HANDLER} as the
 * function's handler.
 *
 * Environment it reads: `ASSET_BUCKET` / `ASSET_KEY_PREFIX`
 * (`assetProxyEnvironment`), `API_GW_BASE` (the backend base, when the app
 * has an API) and {@link APP_ROUTER_IMAGE_FUNCTION_ENV} (when it has an image
 * function).
 *
 * @internal Framework-only.
 */
import { generateAlbApiProxyCode } from './alb_api_proxy.js';
import { ORIGIN_VERIFY_HEADER } from './alb_construct.js';
import { type AssetProxyOptions, assetProxyCoreJs } from './asset_proxy_core.js';

/** The router's file name in a server bundle. */
export const APP_ROUTER_FILE = 'blocks_app_router.cjs';

/** The server function's `handler` setting when the router is in front of it. */
export const APP_ROUTER_HANDLER = 'blocks_app_router.handler';

/** The environment variable that names the image function the router invokes. */
export const APP_ROUTER_IMAGE_FUNCTION_ENV = 'BLOCKS_IMAGE_FUNCTION';

/** How the router reaches the framework for `server` routes. */
export type AppRouterServer =
	| {
			/** A native Lambda handler, imported in-process. */
			readonly kind: 'handler';
			/** The handler's module, relative to the router (e.g. `./index.mjs`). */
			readonly module: string;
			/** The handler's export name (e.g. `handler`). */
			readonly export: string;
	  }
	| {
			/** An HTTP server process (what the Lambda Web Adapter would run). */
			readonly kind: 'http';
			/** The port the server listens on (set as `PORT`). */
			readonly port: number;
			/** The bundle-relative start command: a `.js`/`.mjs`/`.cjs` module, or an executable (`run.sh`). */
			readonly start: string;
			/** How long a request waits for the server to listen, in milliseconds. @default 10000 */
			readonly readyTimeoutMs?: number;
	  };

/** Options of {@link generateAppRouterCode}. */
export type AppRouterOptions = Omit<AssetProxyOptions, 'stripPrefix'> & {
	/** The neutral route table, most-specific first (`HostingPlan.routes.entries`). */
	readonly routes: readonly { readonly pattern: string; readonly kind: 'static' | 'server' | 'image' }[];
	/** The site's basePath, when it has one. */
	readonly basePath?: string;
	/** The Next.js `assetPrefix`, when the app has one. */
	readonly assetPrefix?: string;
	/** The API paths forwarded to the backend (`origins.api.paths`); omit when the app has no API. */
	readonly apiPaths?: readonly string[];
	/** Whether the deploy has an image function (named by {@link APP_ROUTER_IMAGE_FUNCTION_ENV}). */
	readonly image?: boolean;
	/** The framework server, when the app has one. */
	readonly server?: AppRouterServer;
};

/**
 * The router's CommonJS source (see the module doc).
 *
 * @param opts the route table, the app's rules and error pages, the API paths, and the server.
 * @returns the module source; it exports `handler`.
 */
export const generateAppRouterCode = (opts: AppRouterOptions): string => {
	const routes = JSON.stringify(opts.routes.map((r) => [r.pattern, r.kind]));
	const server = opts.server;
	return `'use strict';
// Generated by @aws-blocks/hosting: the app router (front door with routing: 'app').
${assetProxyCoreJs({ ...opts, stripPrefix: opts.basePath ?? '' })}

const { STATUS_CODES } = require('node:http');
const ROUTER_ROUTES = ${routes};
const ROUTER_BASE_PATH = ${JSON.stringify(opts.basePath ?? '')};
const ROUTER_ASSET_PREFIX = ${JSON.stringify(opts.assetPrefix ?? '')};
const ROUTER_API_PATHS = ${JSON.stringify(opts.apiPaths ?? [])};
const ROUTER_HAS_IMAGE = ${opts.image ? 'true' : 'false'};
const ROUTER_SERVER = ${JSON.stringify(server?.kind ?? '')};
const ROUTER_ORIGIN_VERIFY = ${JSON.stringify(ORIGIN_VERIFY_HEADER)};
// Content types relayed as UTF-8 text rather than base64.
const ROUTER_TEXT_TYPE = /^(text\\/|application\\/(json|javascript|xml|x-www-form-urlencoded|[\\w.+-]*\\+(json|xml))\\b)/i;

${opts.apiPaths && opts.apiPaths.length > 0 ? routerApiJs(opts) : "function routerForwardApi() { throw new Error('no API'); }"}

${server?.kind === 'handler' ? routerHandlerServerJs(server) : ''}${server?.kind === 'http' ? routerHttpServerJs(server) : ''}
${opts.image ? ROUTER_IMAGE_JS : ''}
${ROUTER_CORE_JS}`;
};

/** The API forwarder: the ALB door's, unchanged, in its own scope (built on the first API request). */
const routerApiJs = (
	opts: AppRouterOptions,
): string => `// The ALB door's API forwarder, unchanged, in its own scope. Built on the
// first API request: it reads API_GW_BASE when it loads.
let routerApiHandler;
function routerApiProxy() {
  if (!routerApiHandler) {
    routerApiHandler = (function () {
      const exports = {};
${generateAlbApiProxyCode({ headers: opts.headers })}
      return exports.handler;
    })();
  }
  return routerApiHandler;
}
// The request as the ALB door's forwarder reads it: an ALB event with
// multi-value headers and the query as delivered.
async function routerForwardApi(req) {
  const mvq = {};
  let anyQuery = false;
  for (const pair of req.rawQuery ? req.rawQuery.split('&') : []) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.substring(0, eq);
    (mvq[k] = mvq[k] || []).push(eq === -1 ? '' : pair.substring(eq + 1));
    anyQuery = true;
  }
  const res = await routerApiProxy()({
    httpMethod: req.method,
    path: req.path,
    multiValueHeaders: req.headers,
    multiValueQueryStringParameters: anyQuery ? mvq : null,
    body: req.body === null ? null : req.body.toString('base64'),
    isBase64Encoded: req.body !== null,
  });
  return routerFromLambda(res);
}
`;

/** `server` routes → a native Lambda handler module, imported in-process. */
const routerHandlerServerJs = (
	server: Extract<AppRouterServer, { kind: 'handler' }>,
): string => `// The framework's native handler, loaded during init (awaited on first use).
const routerInnerModule = import(require('node:url').pathToFileURL(require('node:path').join(__dirname, ${JSON.stringify(server.module)})).href);
routerInnerModule.catch(() => {});
async function routerInnerHandler() {
  const mod = await routerInnerModule;
  const run = mod[${JSON.stringify(server.export)}] || (mod.default && mod.default[${JSON.stringify(server.export)}]);
  if (typeof run !== 'function') throw new Error('app router: the server module exports no ' + ${JSON.stringify(server.export)} + ' handler');
  return run;
}
async function routerServer(req, context) {
  const run = await routerInnerHandler();
  return routerFromLambda(await run(routerV2Event(req, req.path, context), context));
}
`;

/** `server` routes → an HTTP server child process on its local port. */
const routerHttpServerJs = (
	server: Extract<AppRouterServer, { kind: 'http' }>,
): string => `// The framework's HTTP server (what the Lambda Web Adapter would run), started
// during init as a child process; a request waits until it listens.
const routerHttp = require('node:http');
const routerNet = require('node:net');
const ROUTER_SERVER_PORT = ${server.port};
const ROUTER_SERVER_START = ${JSON.stringify(server.start)};
const ROUTER_SERVER_READY_MS = ${server.readyTimeoutMs ?? 10000};
// Request headers never sent to the server: hop-by-hop ones, and the stacked
// router's origin-verify secret.
// (Each side's content-length is the relayed body's own.)
const ROUTER_HOP = { 'connection': 1, 'keep-alive': 1, 'proxy-connection': 1, 'te': 1, 'trailer': 1, 'transfer-encoding': 1, 'upgrade': 1, 'content-length': 1 };
let routerProc = null;
let routerReady = null;
function routerStartServer() {
  if (routerProc && routerProc.exitCode === null && routerProc.signalCode === null && routerReady) return routerReady;
  if (!routerProc || routerProc.exitCode !== null || routerProc.signalCode !== null) {
    const path = require('node:path');
    const entry = path.join(__dirname, ROUTER_SERVER_START);
    const js = /\\.(c|m)?js$/.test(entry);
    const env = Object.assign({}, process.env, { PORT: String(ROUTER_SERVER_PORT) });
    routerProc = require('node:child_process').spawn(js ? process.execPath : entry, js ? [entry] : [], { cwd: __dirname, env, stdio: 'inherit' });
    routerProc.on('error', (err) => { console.error('app router: the server failed to start', err); });
  }
  const proc = routerProc;
  routerReady = new Promise((resolve, reject) => {
    const started = Date.now();
    (function attempt() {
      if (proc.exitCode !== null || proc.signalCode !== null) return reject(new Error('app router: the server exited (' + (proc.exitCode !== null ? proc.exitCode : proc.signalCode) + ')'));
      const socket = routerNet.connect(ROUTER_SERVER_PORT, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > ROUTER_SERVER_READY_MS) return reject(new Error('app router: the server did not listen on port ' + ROUTER_SERVER_PORT));
        setTimeout(attempt, 10);
      });
    })();
  });
  routerReady.catch(() => { routerReady = null; });
  return routerReady;
}
routerStartServer().catch(() => {});
async function routerServer(req) {
  await routerStartServer();
  const headers = {};
  for (const name in req.headers) {
    if (ROUTER_HOP[name] || name === ROUTER_ORIGIN_VERIFY) continue;
    headers[name] = req.headers[name].join(name === 'cookie' ? '; ' : ', ');
  }
  routerForwardedHeaders(headers);
  if (req.body !== null) headers['content-length'] = String(req.body.length);
  return await new Promise((resolve, reject) => {
    const r = routerHttp.request({ host: '127.0.0.1', port: ROUTER_SERVER_PORT, method: req.method, path: req.path + (req.rawQuery ? '?' + req.rawQuery : ''), headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const out = {};
        for (const name in res.headers) {
          if (ROUTER_HOP[name]) continue;
          const v = res.headers[name];
          out[name] = Array.isArray(v) ? v.map(String) : [String(v)];
        }
        resolve({ statusCode: res.statusCode || 502, headers: out, body: Buffer.concat(chunks).toString('base64'), isBase64Encoded: true });
      });
    });
    r.on('error', reject);
    r.end(req.body === null ? undefined : req.body);
  });
}
`;

/** `image` routes → the image function, invoked with a payload 2.0 event. */
const ROUTER_IMAGE_JS = `// The image function, invoked with a payload 2.0 event (what its Function URL sends).
let routerLambda = null;
async function routerImage(req, uri, context) {
  const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
  routerLambda = routerLambda || new LambdaClient({});
  const out = await routerLambda.send(new InvokeCommand({
    FunctionName: process.env.${APP_ROUTER_IMAGE_FUNCTION_ENV},
    Payload: Buffer.from(JSON.stringify(routerV2Event(req, uri, context))),
  }));
  if (out.FunctionError) throw new Error('app router: the image function failed (' + out.FunctionError + ')');
  return routerFromLambda(JSON.parse(Buffer.from(out.Payload || []).toString('utf8') || 'null'));
}
`;

/** The event normalization, dispatch and response shaping. */
const ROUTER_CORE_JS = `// ── Events in ──────────────────────────────────────────────────────────────
// One request shape for every event: the method, the raw path and query, the
// headers (lower-case names, every value), and the body bytes. null for an
// event that is not an HTTP request.
function routerRequest(event) {
  if (!event || typeof event !== 'object') return null;
  const rc = event.requestContext || {};
  const headers = {};
  const add = (name, value) => {
    if (value == null) return;
    const key = String(name).toLowerCase();
    (headers[key] = headers[key] || []).push(String(value));
  };
  const addAll = (single, multi) => {
    if (multi) { for (const name in multi) for (const v of [].concat(multi[name])) add(name, v); }
    else { for (const name in single || {}) add(name, single[name]); }
  };
  let shape;
  let method;
  let path;
  let rawQuery = '';
  let multi = false;
  if (rc.elb) {
    // ALB: the query arrives as delivered (still percent-encoded).
    shape = 'alb';
    multi = event.multiValueHeaders != null;
    method = event.httpMethod;
    path = event.path;
    addAll(event.headers, event.multiValueHeaders);
    rawQuery = routerJoinQuery(event.multiValueQueryStringParameters || routerSingleQuery(event.queryStringParameters), false);
  } else if (event.version === '2.0' || (rc.http && typeof event.rawPath === 'string')) {
    // HTTP API / Function URL (payload 2.0): cookies travel apart from the headers.
    shape = 'v2';
    method = rc.http && rc.http.method;
    path = event.rawPath;
    addAll(event.headers, null);
    if (Array.isArray(event.cookies) && event.cookies.length > 0) headers.cookie = [event.cookies.join('; ')];
    rawQuery = event.rawQueryString || '';
  } else if (typeof event.httpMethod === 'string' && typeof event.path === 'string') {
    // REST API (payload 1.0): the query arrives decoded.
    shape = 'v1';
    method = event.httpMethod;
    path = event.path;
    addAll(event.headers, event.multiValueHeaders);
    rawQuery = routerJoinQuery(event.multiValueQueryStringParameters || routerSingleQuery(event.queryStringParameters), true);
  } else {
    return null;
  }
  const body = event.body == null || event.body === '' ? null : Buffer.from(String(event.body), event.isBase64Encoded ? 'base64' : 'utf8');
  return { shape, multi, method: String(method || 'GET').toUpperCase(), path: path || '/', rawQuery, headers, body };
}
function routerSingleQuery(q) {
  if (!q) return null;
  const out = {};
  for (const k in q) out[k] = [q[k]];
  return out;
}
function routerJoinQuery(mv, encode) {
  if (!mv) return '';
  const parts = [];
  for (const k in mv) {
    for (const v of [].concat(mv[k])) parts.push(encode ? encodeURIComponent(k) + '=' + encodeURIComponent(v == null ? '' : v) : k + '=' + (v == null ? '' : v));
  }
  return parts.join('&');
}
function routerParseQuery(raw) {
  const out = {};
  for (const pair of raw ? raw.split('&') : []) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const dec = (s) => { try { return decodeURIComponent(s.replace(/\\+/g, ' ')); } catch (e) { return s; } };
    const k = dec(eq === -1 ? pair : pair.substring(0, eq));
    const v = dec(eq === -1 ? '' : pair.substring(eq + 1));
    out[k] = Object.prototype.hasOwnProperty.call(out, k) ? out[k] + ',' + v : v;
  }
  return out;
}

// The public host the framework builds absolute URLs from is the request's
// Host, over any x-forwarded-host the client sent (as the ALB door's shim does).
function routerForwardedHeaders(headers) {
  delete headers['x-forwarded-host'];
  if (headers.host) headers['x-forwarded-host'] = headers.host;
  if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = 'https';
}

// The payload 2.0 event a framework handler (OpenNext \`aws-apigw-v2\`, Nitro
// \`aws-lambda\`) or the image function reads.
function routerV2Event(req, path, context) {
  const headers = {};
  let cookies;
  for (const name in req.headers) {
    if (name === ROUTER_ORIGIN_VERIFY) continue;
    if (name === 'cookie') { cookies = req.headers[name].join('; ').split(/;\\s*/).filter(Boolean); continue; }
    headers[name] = req.headers[name].join(', ');
  }
  routerForwardedHeaders(headers);
  const query = routerParseQuery(req.rawQuery);
  const xff = headers['x-forwarded-for'] ? headers['x-forwarded-for'].split(',')[0].trim() : '';
  const now = new Date();
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: req.rawQuery,
    ...(cookies && cookies.length > 0 ? { cookies } : {}),
    headers,
    ...(Object.keys(query).length > 0 ? { queryStringParameters: query } : {}),
    requestContext: {
      accountId: 'anonymous',
      apiId: 'blocks-app-router',
      domainName: headers.host || '',
      domainPrefix: (headers.host || '').split('.')[0],
      http: { method: req.method, path, protocol: 'HTTP/1.1', sourceIp: xff, userAgent: headers['user-agent'] || '' },
      requestId: (context && context.awsRequestId) || '',
      routeKey: '$default',
      stage: '$default',
      time: now.toISOString(),
      timeEpoch: now.getTime(),
    },
    ...(req.body !== null ? { body: req.body.toString('base64'), isBase64Encoded: true } : { isBase64Encoded: false }),
  };
}

// ── Responses ──────────────────────────────────────────────────────────────
// One response shape inside the router: lower-case header names, every value.
function routerFromLambda(r) {
  if (r == null) r = {};
  if (typeof r === 'string') r = { statusCode: 200, body: r };
  else if (typeof r === 'object' && r.statusCode === undefined && r.body === undefined && r.headers === undefined) {
    // A payload 2.0 handler may return a bare JSON value.
    r = { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(r) };
  }
  const headers = {};
  for (const name in r.headers || {}) {
    const v = r.headers[name];
    if (v != null) headers[name.toLowerCase()] = [].concat(v).map(String);
  }
  for (const name in r.multiValueHeaders || {}) {
    const key = name.toLowerCase();
    const values = [].concat(r.multiValueHeaders[name]).filter((v) => v != null).map(String);
    headers[key] = key === 'set-cookie' && headers[key] ? headers[key].concat(values) : values;
  }
  if (Array.isArray(r.cookies) && r.cookies.length > 0) headers['set-cookie'] = (headers['set-cookie'] || []).concat(r.cookies.map(String));
  return {
    statusCode: Number(r.statusCode) || 200,
    headers,
    body: r.body == null ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
    isBase64Encoded: Boolean(r.isBase64Encoded),
  };
}

// A blocksServe result (single-value headers) in the router's shape.
function routerFromServe(res) {
  const headers = {};
  for (const name in res.headers) headers[name.toLowerCase()] = [String(res.headers[name])];
  return { statusCode: res.statusCode, headers, body: res.body, isBase64Encoded: res.isBase64Encoded };
}

// The app's rules on a server or image response: its error pages (a 404 or
// 500 with a page configured is replaced by the page, keeping the cookies the
// server set), its header rules (status below 400), and the baseline security
// headers the response doesn't set itself.
async function routerFinish(res, uri) {
  const page = res.statusCode === 404 ? NOT_FOUND_PAGE : res.statusCode === 500 ? SERVER_ERROR_PAGE : '';
  if (page) {
    const pageRes = await errorResponse(res.statusCode);
    if (pageRes.isBase64Encoded) {
      const cookies = res.headers['set-cookie'];
      res = routerFromServe(pageRes);
      if (cookies) res.headers['set-cookie'] = cookies;
    }
  }
  if (res.statusCode < 400) {
    const rule = blocksHeaders(uri);
    for (const name in rule) res.headers[name] = [rule[name]];
  }
  return routerSecure(res);
}
function routerSecure(res) {
  for (const name in SECURITY_HEADERS) if (!res.headers[name]) res.headers[name] = [SECURITY_HEADERS[name]];
  return res;
}

// The router's response in the shape the event came in.
function routerRespond(req, res) {
  let body = res.body;
  let isBase64Encoded = res.isBase64Encoded;
  // A text body goes back as UTF-8 when its bytes round-trip, so base64 does
  // not inflate it by 4/3 against the ALB's 1 MB response limit.
  const type = (res.headers['content-type'] || [''])[0];
  if (isBase64Encoded && !res.headers['content-encoding'] && ROUTER_TEXT_TYPE.test(type)) {
    const buf = Buffer.from(body, 'base64');
    const text = buf.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(buf)) { body = text; isBase64Encoded = false; }
  }
  const last = {};
  for (const name in res.headers) last[name] = res.headers[name][res.headers[name].length - 1];
  if (req.shape === 'alb') {
    const out = { statusCode: res.statusCode, statusDescription: (res.statusCode + ' ' + (STATUS_CODES[res.statusCode] || '')).trim(), isBase64Encoded, body };
    if (req.multi) out.multiValueHeaders = res.headers;
    else out.headers = last;
    return out;
  }
  if (req.shape === 'v1') {
    return { statusCode: res.statusCode, headers: last, multiValueHeaders: res.headers, isBase64Encoded, body };
  }
  const headers = {};
  for (const name in res.headers) if (name !== 'set-cookie') headers[name] = res.headers[name].join(', ');
  const out = { statusCode: res.statusCode, headers, isBase64Encoded, body };
  if (res.headers['set-cookie']) out.cookies = res.headers['set-cookie'];
  return out;
}

// ── Dispatch ───────────────────────────────────────────────────────────────
function routerMatches(uri, patterns) {
  for (let i = 0; i < patterns.length; i++) if (matchPattern(uri, patterns[i])) return true;
  return false;
}
// The route kind for a path: the first matching route (\`/about/\` also matches
// a route written \`/about\`), else the server when there is one, else static.
function routerKind(uri) {
  const alt = uri.length > 1 && uri.charAt(uri.length - 1) === '/' ? uri.substring(0, uri.length - 1) : null;
  for (let i = 0; i < ROUTER_ROUTES.length; i++) {
    const pattern = ROUTER_ROUTES[i][0];
    if (matchPattern(uri, pattern) || (alt !== null && matchPattern(alt, pattern))) return ROUTER_ROUTES[i][1];
  }
  return ROUTER_SERVER ? 'server' : 'static';
}
function routerFlatHeaders(req) {
  const out = {};
  for (const name in req.headers) out[name] = req.headers[name].join(name === 'cookie' ? '; ' : ', ');
  return out;
}
function routerRedirect(statusCode, location) {
  return routerSecure({ statusCode, headers: { location: [location] }, body: '', isBase64Encoded: false });
}

async function routerRoute(req, context) {
  let uri = req.path;
  // 1. The app's redirects.
  const redirect = blocksRedirect(uri);
  if (redirect) return routerRedirect(redirect.statusCode, redirect.location);
  // 2. The same-origin API.
  if (ROUTER_API_PATHS.length > 0 && routerMatches(uri, ROUTER_API_PATHS)) return routerSecure(await routerForwardApi(req));
  // 3. The assetPrefix (into the basePath form), then the basePath.
  if (ROUTER_ASSET_PREFIX && (uri === ROUTER_ASSET_PREFIX || uri.indexOf(ROUTER_ASSET_PREFIX + '/') === 0)) {
    uri = uri.substring(ROUTER_ASSET_PREFIX.length) || '/';
    if (ROUTER_BASE_PATH && uri !== ROUTER_BASE_PATH && uri.indexOf(ROUTER_BASE_PATH + '/') !== 0) uri = uri === '/' ? ROUTER_BASE_PATH + '/' : ROUTER_BASE_PATH + uri;
  }
  if (ROUTER_BASE_PATH && uri !== ROUTER_BASE_PATH && uri.indexOf(ROUTER_BASE_PATH + '/') !== 0) {
    return routerRedirect(308, (uri === '/' ? ROUTER_BASE_PATH + '/' : ROUTER_BASE_PATH + uri) + (req.rawQuery ? '?' + req.rawQuery : ''));
  }
  // 4. The route table.
  const kind = routerKind(uri);
  if (kind === 'image' && ROUTER_HAS_IMAGE) return routerFinish(await routerImage(req, stripBasePath(uri, ROUTER_BASE_PATH), context), uri);
  if (!ROUTER_HAS_IMAGE) {
    // No image function: the image endpoints answer with the source image.
    const image = blocksImageSource(uri, routerParseQuery(req.rawQuery));
    if (image && image.redirect) return routerRedirect(302, image.redirect);
    if (image && image.status) return routerFromServe(secure(await errorResponse(image.status)));
    if (image) return routerFromServe(await blocksServe(image.uri, routerFlatHeaders(req)));
  }
  if (kind === 'server' && ROUTER_SERVER) return routerFinish(await routerServer(req, context), uri);
  return routerFromServe(await blocksServe(uri, routerFlatHeaders(req)));
}

exports.handler = async (event, context) => {
  const req = routerRequest(event);
  if (!req) {
    // Not an HTTP request (e.g. a scheduled warmup): the server handler's to answer.
    if (ROUTER_SERVER === 'handler') return (await routerInnerHandler())(event, context);
    return { statusCode: 400, body: 'Bad Request' };
  }
  let res;
  try {
    res = await routerRoute(req, context);
  } catch (err) {
    // Logged for the operator; never echoed.
    console.error('app router error', err);
    res = routerSecure({ statusCode: 502, headers: { 'content-type': ['text/plain; charset=utf-8'] }, body: 'Bad Gateway', isBase64Encoded: false });
  }
  return routerRespond(req, res);
};
`;
