// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The SSR cache guard: a small runtime module written into the server bundle
 * at synth that keeps credential-bearing and cookie-setting SSR responses out
 * of shared caches.
 *
 * The SSR cache policy honors the origin's `Cache-Control`, and its cache key
 * holds only the Next.js router headers, the preview cookies and the
 * configured `cacheKeyCookies`/`cacheKeyHeaders`. A response the origin marks
 * shared-cacheable (`s-maxage`, `public`, `max-age` without `private`, a
 * future `Expires`, or no caching headers while `ssrDefaultTtl > 0`) for a request whose credentials
 * are NOT in that key would be stored once and answer every request with the
 * same key, whatever credentials they carry (CloudFront ignores `Vary`). And
 * CloudFront stores a response's `Set-Cookie` with the object and replays it
 * on every hit. The guard rewrites `Cache-Control` to `private, no-store`:
 *
 *   - on every response that carries `Set-Cookie`;
 *   - on a shared-cacheable response to a request that carries
 *     `Authorization` (unless `authorization` is a configured cache-key
 *     header) or a cookie whose name is not in the cache key.
 *
 * Responses already `private`/`no-store`, or `no-cache` without `s-maxage`,
 * are left as they are. Adding the credential to `cacheKeyCookies` /
 * `cacheKeyHeaders` puts it in the key, so those responses stay cacheable.
 *
 * Where it runs (every SSR server shape the hosting construct builds, so it
 * does not depend on the framework or on how the server is invoked):
 *
 *   - Node HTTP servers (a Lambda Web Adapter server, a Lambda Web Function
 *     server): the module patches `http.ServerResponse#writeHead`, which every
 *     Node HTTP response passes through (explicitly, or implicitly on the
 *     first write). It is loaded before the server — through `NODE_OPTIONS`
 *     `--import` on Lambda, and through the entry module on a Web Function.
 *   - Native Lambda handlers (OpenNext, Nitro's `aws-lambda` preset): a handler
 *     wrapper rewrites a buffered result's headers, and a streaming handler's
 *     response prelude (the JSON metadata written before the body, either
 *     through `awslambda.HttpResponseStream.from` or written directly).
 *
 * The Node HTTP server path needs a Node.js server; a server the guard cannot
 * be installed in front of (see {@link withSsrCacheGuard}) gets a synth warning
 * instead.
 *
 * The cache-key names are baked into the generated module, so nothing is read
 * from the environment at runtime.
 *
 * @module
 * @internal Framework-only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Token, type Duration } from 'aws-cdk-lib';
import type { ComputeResource } from '../manifest/types.js';

/** The guard module's file name in the server bundle. */
export const SSR_CACHE_GUARD_FILE = 'blocks_cache_guard.mjs';

/** The handler wrapper's file name in the server bundle. */
export const SSR_CACHE_GUARD_HANDLER_FILE = 'blocks_cache_guard_handler.mjs';

/** The server's `handler` setting when the wrapper is in front of it. */
export const SSR_CACHE_GUARD_HANDLER = 'blocks_cache_guard_handler.handler';

/** The Web Function entry module that loads the guard before the server. */
export const SSR_CACHE_GUARD_ENTRY_FILE = 'blocks_cache_guard_entry.mjs';

/**
 * Where Lambda unpacks the function code. A Lambda Web Adapter server is
 * started by `run.sh`, which may `cd` into a subdirectory, so `--import` names
 * the guard by absolute path rather than relative to the working directory.
 */
const LAMBDA_TASK_ROOT = '/var/task';

/**
 * Cookie names never treated as credentials: the two Next.js preview cookies
 * are always in the SSR cache key, and `__dpl` is the router's build pin
 * (skew protection), which selects a build and does not personalize a page.
 */
export const SSR_CACHE_GUARD_RESERVED_COOKIES: readonly string[] = [
  '__prerender_bypass',
  '__next_preview_data',
  '__dpl',
];

/** The `Cache-Control` value the guard writes. */
export const SSR_CACHE_GUARD_PRIVATE = 'private, no-store';

/** What the guard needs to know about the SSR cache key. */
export interface SsrCacheGuardConfig {
  /** `cacheKeyCookies` (case-sensitive names). */
  readonly cacheKeyCookies?: readonly string[];
  /** `cacheKeyHeaders` (compared lower-cased). */
  readonly cacheKeyHeaders?: readonly string[];
  /**
   * Whether `ssrDefaultTtl` is positive, i.e. a response with no
   * `Cache-Control` is edge-cached. @default false
   */
  readonly defaultTtlPositive?: boolean;
}

/**
 * Whether `ssrDefaultTtl` makes a response without `Cache-Control` cacheable.
 * An unresolved token cannot be proven `<= 0`, so it counts as positive (the
 * same rule as the synth guard in the CDN construct).
 *
 * @param ttl `ssrDefaultTtl`.
 * @returns true when the default TTL is, or may be, positive.
 */
export const isDefaultTtlPositive = (ttl: Duration | undefined): boolean => {
  if (!ttl) return false;
  const secs = ttl.toSeconds({ integral: false });
  return Token.isUnresolved(secs) || secs > 0;
};

/**
 * The guard module's source: exports `guardCacheControl`, `requestInfoFromEvent`,
 * `guardResult`, `guardStream` and `runWithRequest`, and patches
 * `http.ServerResponse#writeHead` when it is first evaluated.
 *
 * @param config the cache-key names and the default-TTL flag.
 * @returns the ES module source.
 */
export const generateSsrCacheGuardModule = (config: SsrCacheGuardConfig): string => {
  const cookies = [...new Set([...SSR_CACHE_GUARD_RESERVED_COOKIES, ...(config.cacheKeyCookies ?? [])])];
  const headers = [...new Set((config.cacheKeyHeaders ?? []).map((h) => h.toLowerCase()))];
  return `// Generated by @aws-blocks/hosting: keeps credential-bearing and cookie-setting SSR responses out of shared caches.
import * as http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';

const KEY_COOKIES = new Set(${JSON.stringify(cookies)});
const KEY_HEADERS = new Set(${JSON.stringify(headers)});
const DEFAULT_TTL_POSITIVE = ${config.defaultTtlPositive === true};
const PRIVATE = ${JSON.stringify(SSR_CACHE_GUARD_PRIVATE)};
const PRELUDE_TYPE = 'application/vnd.awslambda.http-integration-response';
const INSTALLED = Symbol.for('aws-blocks.hosting.ssr-cache-guard');

function cookieNames(value) {
  const names = [];
  for (const header of [].concat(value == null ? [] : value)) {
    for (const part of String(header).split(';')) {
      const eq = part.indexOf('=');
      const name = (eq === -1 ? part : part.slice(0, eq)).trim();
      if (name) names.push(name);
    }
  }
  return names;
}

// Whether Expires names a valid date in the future (CloudFront uses it as the
// TTL when Cache-Control gives none).
function expiresInFuture(expires) {
  if (expires == null) return false;
  const at = Date.parse(String(expires));
  return !Number.isNaN(at) && at > Date.now();
}

// Whether a response with this Cache-Control (and Expires) can be stored by a
// shared cache. private/no-store are never stored; s-maxage gives a shared TTL
// even next to no-cache; no-cache alone means revalidate on every request (not
// stored with a zero minimum TTL); public, max-age or a future Expires are
// stored; anything else (or no header) falls back to the default TTL.
// Directives are split on every comma, including one inside a quoted value
// (e.g. no-cache="a, b"); a split there can only add directive names such as
// private or no-store, so a mis-split errs toward not-cacheable.
function sharedCacheable(cacheControl, expires) {
  const future = expiresInFuture(expires);
  if (cacheControl == null || String(cacheControl).trim() === '') return future || DEFAULT_TTL_POSITIVE;
  const directives = new Set();
  for (const part of String(cacheControl).split(',')) {
    const name = part.split('=')[0].trim().toLowerCase();
    if (name) directives.add(name);
  }
  if (directives.has('private') || directives.has('no-store')) return false;
  if (directives.has('s-maxage')) return true;
  if (directives.has('no-cache')) return false;
  if (directives.has('public') || directives.has('max-age')) return true;
  return future || DEFAULT_TTL_POSITIVE;
}

/**
 * The Cache-Control to send instead, or null to leave the response as is.
 * request: { authorization: boolean, cookies: string[] } (cookie names).
 * response: { cacheControl: string | undefined, expires?: string, setCookie: boolean }.
 */
export function guardCacheControl(request, response) {
  if (response.setCookie) return response.cacheControl === PRIVATE ? null : PRIVATE;
  if (!request) return null;
  const credentialed =
    (request.authorization && !KEY_HEADERS.has('authorization')) ||
    request.cookies.some((name) => !KEY_COOKIES.has(name));
  if (!credentialed || !sharedCacheable(response.cacheControl, response.expires)) return null;
  return PRIVATE;
}

function headerValues(map, name) {
  const out = [];
  if (!map) return out;
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === name && map[key] != null) out.push(...[].concat(map[key]).map(String));
  }
  return out;
}

/** The request facts the guard needs, from a Lambda event (API Gateway REST/HTTP, Function URL, ALB). */
export function requestInfoFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const authorization =
    headerValues(event.headers, 'authorization').length > 0 ||
    headerValues(event.multiValueHeaders, 'authorization').length > 0;
  const cookies = cookieNames([
    ...headerValues(event.headers, 'cookie'),
    ...headerValues(event.multiValueHeaders, 'cookie'),
    ...(Array.isArray(event.cookies) ? event.cookies : []),
  ]);
  return { authorization, cookies: [...new Set(cookies)] };
}

function setHeader(map, name, value, multi) {
  for (const key of Object.keys(map)) if (key.toLowerCase() === name) delete map[key];
  map[name] = multi ? [value] : value;
}

// Rewrite the headers of a buffered result or a streaming prelude in place.
function guardHeaders(target, request) {
  if (!target || typeof target !== 'object') return target;
  const inHeaders = headerValues(target.headers, 'cache-control');
  const inMulti = headerValues(target.multiValueHeaders, 'cache-control');
  const cacheControl = [...inHeaders, ...inMulti];
  const expires = [...headerValues(target.headers, 'expires'), ...headerValues(target.multiValueHeaders, 'expires')][0];
  const setCookie =
    headerValues(target.headers, 'set-cookie').length > 0 ||
    headerValues(target.multiValueHeaders, 'set-cookie').length > 0 ||
    (Array.isArray(target.cookies) && target.cookies.length > 0);
  const next = guardCacheControl(request, {
    cacheControl: cacheControl.length ? cacheControl.join(', ') : undefined,
    expires,
    setCookie,
  });
  if (next == null) return target;
  // Replace Cache-Control in each map that held it. With none to replace, add
  // it to multiValueHeaders when present (else headers), so it is sent once.
  if (inMulti.length || (!inHeaders.length && target.multiValueHeaders)) {
    setHeader(target.multiValueHeaders, 'cache-control', next, true);
  }
  if (inHeaders.length || (!inMulti.length && !target.multiValueHeaders)) {
    target.headers = target.headers || {};
    setHeader(target.headers, 'cache-control', next, false);
  }
  return target;
}

/** Guard a buffered Lambda handler result. */
export function guardResult(result, request) {
  return guardHeaders(result, request);
}

const requestStore = new AsyncLocalStorage();
const guardedStreams = new WeakSet();

/** Run a streaming invocation with its request facts in scope for HttpResponseStream.from. */
export function runWithRequest(request, fn) {
  return requestStore.run(request, fn);
}

// Guard the prelude in a handler's first write. The write may also carry the
// 8-NUL delimiter and the start of the body: only the part before the first
// NUL is the JSON prelude, and the rest is passed on byte for byte.
function guardPreludeChunk(chunk, request) {
  try {
    const isString = typeof chunk === 'string';
    const bytes = isString
      ? null
      : ArrayBuffer.isView(chunk)
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : Buffer.from(chunk);
    const nul = isString ? chunk.indexOf('\0') : bytes.indexOf(0);
    const head = isString ? (nul === -1 ? chunk : chunk.slice(0, nul)) : (nul === -1 ? bytes : bytes.subarray(0, nul)).toString('utf8');
    const prelude = JSON.parse(head);
    if (!prelude || typeof prelude !== 'object' || Array.isArray(prelude)) return chunk;
    const json = JSON.stringify(guardHeaders(prelude, request));
    if (nul === -1) return json;
    return isString ? json + chunk.slice(nul) : Buffer.concat([Buffer.from(json, 'utf8'), bytes.subarray(nul)]);
  } catch {
    return chunk;
  }
}

/**
 * Guard a response stream whose prelude the handler writes itself: after
 * setContentType(<http-integration-response>), the first write is the JSON
 * prelude. A stream whose prelude HttpResponseStream.from already guarded is
 * skipped, so a body chunk is never read as a prelude.
 */
export function guardStream(stream, request) {
  if (!stream || typeof stream.write !== 'function') return stream;
  let integration = false;
  let done = false;
  const setContentType = stream.setContentType;
  if (typeof setContentType === 'function') {
    stream.setContentType = function (type) {
      if (String(type) === PRELUDE_TYPE) integration = true;
      return setContentType.apply(this, arguments);
    };
  }
  const write = stream.write;
  stream.write = function (chunk, ...rest) {
    if (integration && !done) {
      done = true;
      if (!guardedStreams.has(stream)) chunk = guardPreludeChunk(chunk, request);
    }
    return write.call(this, chunk, ...rest);
  };
  return stream;
}

function installHttpServerGuard() {
  const proto = http.ServerResponse.prototype;
  if (proto[INSTALLED]) return;
  proto[INSTALLED] = true;
  const writeHead = proto.writeHead;
  proto.writeHead = function (statusCode, ...args) {
    try {
      const req = this.req;
      if (req && req.headers && !this.headersSent) {
        // writeHead(status, [statusMessage], [headers])
        const index = typeof args[0] === 'string' ? 1 : 0;
        let extra = args[index];
        const pairs = [];
        if (Array.isArray(extra)) {
          if (extra.length && Array.isArray(extra[0])) for (const [k, v] of extra) pairs.push([String(k), v]);
          else for (let i = 0; i + 1 < extra.length; i += 2) pairs.push([String(extra[i]), extra[i + 1]]);
        } else if (extra && typeof extra === 'object') {
          for (const k of Object.keys(extra)) pairs.push([k, extra[k]]);
        }
        const fromArgs = (name) => pairs.filter(([k, v]) => k.toLowerCase() === name && v != null).flatMap(([, v]) => [].concat(v).map(String));
        const argCacheControl = fromArgs('cache-control');
        const current = this.getHeader('cache-control');
        const cacheControl = argCacheControl.length ? argCacheControl.join(', ') : current == null ? undefined : [].concat(current).join(', ');
        const argExpires = fromArgs('expires');
        const currentExpires = this.getHeader('expires');
        const expires = argExpires.length ? argExpires[0] : currentExpires == null ? undefined : String([].concat(currentExpires)[0]);
        const setCookie = fromArgs('set-cookie').length > 0 || this.getHeader('set-cookie') != null;
        const request = {
          authorization: req.headers.authorization != null,
          cookies: [...new Set(cookieNames(req.headers.cookie))],
        };
        const next = guardCacheControl(request, { cacheControl, expires, setCookie });
        if (next != null) {
          this.setHeader('cache-control', next);
          // Headers passed to writeHead are merged over setHeader values, so
          // replace any Cache-Control among them too.
          if (argCacheControl.length) {
            const kept = pairs.filter(([k]) => k.toLowerCase() !== 'cache-control');
            if (Array.isArray(extra)) {
              extra = extra.length && Array.isArray(extra[0]) ? kept : kept.flat();
            } else {
              extra = Object.fromEntries(kept);
            }
            args[index] = extra;
          }
        }
      }
    } catch {
      // Never fail a response because of the guard.
    }
    return writeHead.call(this, statusCode, ...args);
  };
}

function installResponseStreamGuard() {
  const lambda = globalThis.awslambda;
  const HttpResponseStream = lambda && lambda.HttpResponseStream;
  if (!HttpResponseStream || typeof HttpResponseStream.from !== 'function' || HttpResponseStream[INSTALLED]) return;
  HttpResponseStream[INSTALLED] = true;
  const from = HttpResponseStream.from;
  HttpResponseStream.from = function (underlying, prelude, ...rest) {
    const request = requestStore.getStore();
    if (request !== undefined && prelude && typeof prelude === 'object') {
      guardHeaders(prelude, request);
      guardedStreams.add(underlying);
    }
    return from.call(this, underlying, prelude, ...rest);
  };
}

installHttpServerGuard();
installResponseStreamGuard();
`;
};

/**
 * The handler wrapper's source: guards a native Lambda handler's buffered
 * result or streaming prelude. A streaming handler stays streaming: the
 * wrapper carries the inner handler's runtime markers.
 *
 * @param innerModule the handler's module, relative to the wrapper (e.g. `./index.mjs`).
 * @param innerExport the handler's export name. @default 'handler'
 * @returns the ES module source.
 */
export const generateSsrCacheGuardHandlerCode = (innerModule: string, innerExport = 'handler'): string =>
  `// Generated by @aws-blocks/hosting: SSR cache guard in front of a Lambda handler.
import { guardResult, guardStream, requestInfoFromEvent, runWithRequest } from './${SSR_CACHE_GUARD_FILE}';
import * as inner from ${JSON.stringify(innerModule)};

const run = inner[${JSON.stringify(innerExport)}] || (inner.default && inner.default[${JSON.stringify(innerExport)}]);
const STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming');

export const handler = run[STREAMING]
  ? function (event, responseStream, ...rest) {
      const request = requestInfoFromEvent(event);
      return runWithRequest(request, () => run.call(this, event, guardStream(responseStream, request), ...rest));
    }
  : async function (event, ...rest) {
      const request = requestInfoFromEvent(event);
      return guardResult(await run.call(this, event, ...rest), request);
    };
// A streaming handler (awslambda.streamifyResponse) is marked with symbols the
// runtime reads; the wrapper carries them so it is invoked the same way.
for (const key of Object.getOwnPropertySymbols(run)) handler[key] = run[key];
`;

/**
 * The Web Function entry module's source: loads the guard, then the server.
 *
 * @param serverModule the server's module, relative to the entry (e.g. `./index.mjs`).
 * @param guardModule the guard module, relative to the entry.
 * @returns the ES module source.
 */
export const generateSsrCacheGuardEntryCode = (serverModule: string, guardModule: string): string =>
  `// Generated by @aws-blocks/hosting: load the SSR cache guard before the server.
import ${JSON.stringify(guardModule)};
await import(${JSON.stringify(serverModule)});
`;

const writeIfChanged = (file: string, code: string): void => {
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf-8') !== code) fs.writeFileSync(file, code);
};

/** The `--import` flag that loads the guard in a Lambda Web Adapter server. */
export const SSR_CACHE_GUARD_NODE_OPTION = `--import=file://${LAMBDA_TASK_ROOT}/${SSR_CACHE_GUARD_FILE}`;

/**
 * Prepend the guard's `--import` to a `NODE_OPTIONS` value (once).
 *
 * @param existing the current `NODE_OPTIONS`, if any.
 * @returns the value with the guard loaded first.
 */
export const withSsrCacheGuardNodeOption = (existing: string | undefined): string => {
  const rest = (existing ?? '').trim();
  if (rest.split(/\s+/).includes(SSR_CACHE_GUARD_NODE_OPTION)) return rest;
  return rest ? `${SSR_CACHE_GUARD_NODE_OPTION} ${rest}` : SSR_CACHE_GUARD_NODE_OPTION;
};

/** What {@link withSsrCacheGuard} built. */
export interface SsrCacheGuardResult {
  /** The resource to build (unchanged when the guard was not installed). */
  readonly resource: ComputeResource;
  /**
   * Why the guard could not be installed in front of this server, when it
   * applies to it but was not installed. Unset when the guard was installed,
   * and for resources it does not apply to (Lambda\@Edge, or a bundle that
   * does not exist).
   */
  readonly skipped?: string;
}

/** A Lambda Web Adapter entrypoint that starts Node.js (directly or through a package manager or `node_modules/.bin`). */
const NODE_LAUNCHER = /(?:^|[\s/;&|(`'"])(?:node|nodejs|npm|npx|pnpm|yarn)(?=$|[\s;&|)`'"])|node_modules\//m;

/** A shell entrypoint that drops the `NODE_OPTIONS` it is started with. */
const NODE_OPTIONS_CLEARED = /\bunset\s+(?:-v\s+)?NODE_OPTIONS\b|\benv\s+(?:[^\n]*\s)?-u\s*NODE_OPTIONS\b|\bNODE_OPTIONS=(?![^\n]*\$\{?NODE_OPTIONS\b)/;

/**
 * Why a Lambda Web Adapter entrypoint would not load the guard through
 * `NODE_OPTIONS`, or undefined when it does. A JS entrypoint is run by Node;
 * a shell entrypoint must start Node and keep `NODE_OPTIONS`.
 */
const lambdaWebAdapterSkipReason = (bundle: string, entrypoint: string): string | undefined => {
  if (/\.(m|c)?js$/.test(entrypoint)) return undefined;
  const file = path.join(bundle, entrypoint);
  if (!fs.existsSync(file)) return `the server entrypoint '${entrypoint}' is not in the bundle`;
  const script = fs.readFileSync(file, 'utf-8');
  if (!NODE_LAUNCHER.test(script)) {
    return `the server entrypoint '${entrypoint}' does not start a Node.js server, so NODE_OPTIONS does not load the guard`;
  }
  if (NODE_OPTIONS_CLEARED.test(script)) {
    return `the server entrypoint '${entrypoint}' replaces NODE_OPTIONS, so it does not load the guard`;
  }
  return undefined;
};

/**
 * Put the SSR cache guard in front of a server compute resource. Writes the
 * guard module (and a wrapper or entry module) into the bundle and returns
 * the resource to build:
 *
 *   - `handler` on Lambda: the handler becomes {@link SSR_CACHE_GUARD_HANDLER}.
 *   - `http-server` on Lambda: `NODE_OPTIONS` loads the guard before the server.
 *   - a Web Function: `serverEntry` becomes an entry module next to the server
 *     entry (same directory, so the server keeps its working directory).
 *
 * A resource whose handler module or server entry is not found in the bundle,
 * a Web Function whose server entry is not a `.js`/`.mjs`/`.cjs` module, or a
 * Lambda Web Adapter server that is not a Node.js process loading
 * `NODE_OPTIONS`, is returned unchanged with a `skipped` reason. A Lambda\@Edge
 * resource, or one whose bundle does not exist, is returned unchanged.
 *
 * @param resource the server compute resource.
 * @param config the cache-key names and the default-TTL flag.
 * @param host where the server runs. @default 'lambda'
 * @returns the resource to build, and why the guard was not installed.
 */
export const withSsrCacheGuard = (
  resource: ComputeResource,
  config: SsrCacheGuardConfig,
  host: 'lambda' | 'web-function' = 'lambda',
): SsrCacheGuardResult => {
  if (resource.type === 'edge' || !fs.existsSync(resource.bundle)) return { resource };
  const guardCode = generateSsrCacheGuardModule(config);

  if (host === 'web-function') {
    const candidate = resource.serverEntry ?? resource.entrypoint;
    if (!candidate || !/\.(m|c)?js$/.test(candidate)) {
      return {
        resource,
        skipped: `the Web Function server entry '${candidate ?? 'unset'}' is not a .js/.mjs/.cjs module`,
      };
    }
    const entry = path.posix.normalize(candidate);
    const dir = path.posix.dirname(entry);
    if (!fs.existsSync(path.join(resource.bundle, entry))) {
      return { resource, skipped: `the Web Function server entry '${entry}' is not in the bundle` };
    }
    writeIfChanged(path.join(resource.bundle, dir, SSR_CACHE_GUARD_FILE), guardCode);
    writeIfChanged(
      path.join(resource.bundle, dir, SSR_CACHE_GUARD_ENTRY_FILE),
      generateSsrCacheGuardEntryCode(`./${path.posix.basename(entry)}`, `./${SSR_CACHE_GUARD_FILE}`),
    );
    return {
      resource: { ...resource, serverEntry: dir === '.' ? SSR_CACHE_GUARD_ENTRY_FILE : `${dir}/${SSR_CACHE_GUARD_ENTRY_FILE}` },
    };
  }

  if (resource.type === 'http-server') {
    // The Lambda Web Adapter runs `entrypoint` (default `run.sh`, as in the compute construct).
    const skipped = lambdaWebAdapterSkipReason(resource.bundle, resource.entrypoint ?? 'run.sh');
    if (skipped) return { resource, skipped };
    writeIfChanged(path.join(resource.bundle, SSR_CACHE_GUARD_FILE), guardCode);
    return {
      resource: {
        ...resource,
        environment: {
          ...resource.environment,
          NODE_OPTIONS: withSsrCacheGuardNodeOption(resource.environment?.NODE_OPTIONS),
        },
      },
    };
  }

  if (resource.type !== 'handler') return { resource };
  const handler = resource.handler ?? 'index.handler';
  const dot = handler.lastIndexOf('.');
  if (dot <= 0) return { resource, skipped: `the handler '${handler}' does not name a module and an export` };
  const moduleBase = handler.substring(0, dot);
  const exportName = handler.substring(dot + 1);
  const moduleFile = ['.mjs', '.js', '.cjs']
    .map((ext) => `${moduleBase}${ext}`)
    .find((file) => fs.existsSync(path.join(resource.bundle, file)));
  if (!moduleFile) return { resource, skipped: `the handler module '${moduleBase}' (.mjs/.js/.cjs) is not in the bundle` };
  writeIfChanged(path.join(resource.bundle, SSR_CACHE_GUARD_FILE), guardCode);
  writeIfChanged(
    path.join(resource.bundle, SSR_CACHE_GUARD_HANDLER_FILE),
    generateSsrCacheGuardHandlerCode(`./${moduleFile}`, exportName),
  );
  return { resource: { ...resource, handler: SSR_CACHE_GUARD_HANDLER } };
};
