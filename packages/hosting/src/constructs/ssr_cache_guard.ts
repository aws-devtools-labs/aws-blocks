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
 * future `Expires`, no caching headers while `ssrDefaultTtl > 0`, or an error
 * status CloudFront caches for its error caching minimum TTL without caching
 * headers: 404, 414 and 500 to 504) for a request whose credentials
 * are NOT in that key would be stored once and answer every request with the
 * same key, whatever credentials they carry (CloudFront ignores `Vary`). And
 * CloudFront stores a response's `Set-Cookie` with the object and replays it
 * on every hit. The guard rewrites `Cache-Control` to `private, no-store`:
 *
 *   - on every response that carries `Set-Cookie` and is not already
 *     `private` or `no-store`;
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
 *     through `awslambda.HttpResponseStream.from` or written directly, with or
 *     without the integration content type).
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
import { HostingError } from '../hosting_error.js';
import type { ComputeResource } from '../manifest/types.js';
import { resolveHandlerModule } from './handler_module.js';

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
  /**
   * `cacheGuardIgnoredCookies` (case-sensitive names): cookies that never
   * affect the rendered output, so a request carrying them is treated like
   * one without them (as the `__dpl` build pin is).
   */
  readonly ignoredCookies?: readonly string[];
  /** `cacheKeyHeaders` (compared lower-cased). */
  readonly cacheKeyHeaders?: readonly string[];
  /**
   * Whether the door's server-route cache key holds every cookie (as the
   * CloudFront-over-ALB door's does): no cookie then makes a response depend
   * on credentials outside the key, and only `Authorization` (unless a
   * cache-key header) and `Set-Cookie` lead to a rewrite. @default false
   */
  readonly allCookiesKeyed?: boolean;
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
 * Fail synth when a cookie is both in the SSR cache key and declared as one
 * that never affects the rendered output: the two say opposite things.
 *
 * @param cacheKeyCookies `cacheKeyCookies`.
 * @param ignoredCookies `cacheGuardIgnoredCookies`.
 * @throws HostingError('CacheGuardIgnoredCookieInCacheKeyError') when a name is in both.
 */
export const assertCacheGuardIgnoredCookies = (
  cacheKeyCookies: readonly string[] | undefined,
  ignoredCookies: readonly string[] | undefined,
): void => {
  const keyed = new Set(cacheKeyCookies ?? []);
  const both = [...new Set((ignoredCookies ?? []).filter((name) => keyed.has(name)))];
  if (both.length === 0) return;
  throw new HostingError('CacheGuardIgnoredCookieInCacheKeyError', {
    message: `Cookie(s) ${both.map((n) => `'${n}'`).join(', ')} are in both cacheKeyCookies and cacheGuardIgnoredCookies.`,
    resolution:
      'Keep a cookie in cacheKeyCookies when the rendered output depends on it (the cache is keyed per value), or in ' +
      'cacheGuardIgnoredCookies when it never affects the output (e.g. an analytics or consent cookie), not both.',
  });
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
  const cookies = [
    ...new Set([...SSR_CACHE_GUARD_RESERVED_COOKIES, ...(config.cacheKeyCookies ?? []), ...(config.ignoredCookies ?? [])]),
  ];
  const headers = [...new Set((config.cacheKeyHeaders ?? []).map((h) => h.toLowerCase()))];
  return `// Generated by @aws-blocks/hosting: keeps credential-bearing and cookie-setting SSR responses out of shared caches.
import * as http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';

// The cookies a request may carry without its response depending on
// credentials outside the cache key: the key's cookies, the build pin and the
// cookies declared as never affecting the output.
const KEY_COOKIES = new Set(${JSON.stringify(cookies)});
const KEY_HEADERS = new Set(${JSON.stringify(headers)});
const DEFAULT_TTL_POSITIVE = ${config.defaultTtlPositive === true};
const ALL_COOKIES_KEYED = ${config.allCookiesKeyed === true};
const PRIVATE = ${JSON.stringify(SSR_CACHE_GUARD_PRIVATE)};
const PRELUDE_TYPE = 'application/vnd.awslambda.http-integration-response';
const INSTALLED = Symbol.for('aws-blocks.hosting.ssr-cache-guard');
// The error statuses CloudFront caches from the origin for the error caching
// minimum TTL even when the response has no caching headers.
const ERROR_STATUSES_CACHED = new Set([404, 414, 500, 501, 502, 503, 504]);

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
// stored; anything else (or no header) falls back to the default TTL, or to
// the error caching minimum TTL for an error status CloudFront caches.
// CloudFront uses max-age as its own TTL when s-maxage is absent, so a bare
// max-age is stored at the edge; a credentialed response meant for the browser
// cache only sends private, max-age=..., which the guard leaves unchanged.
// Directives are split on every comma, including one inside a quoted value
// (e.g. no-cache="a, b"); a split there can only add directive names such as
// private or no-store, so a mis-split errs toward not-cacheable.
function sharedCacheable(cacheControl, expires, statusCode) {
  const fallback = expiresInFuture(expires) || DEFAULT_TTL_POSITIVE || ERROR_STATUSES_CACHED.has(Number(statusCode));
  if (cacheControl == null || String(cacheControl).trim() === '') return fallback;
  const directives = new Set();
  for (const part of String(cacheControl).split(',')) {
    const name = part.split('=')[0].trim().toLowerCase();
    if (name) directives.add(name);
  }
  if (directives.has('private') || directives.has('no-store')) return false;
  if (directives.has('s-maxage')) return true;
  if (directives.has('no-cache')) return false;
  if (directives.has('public') || directives.has('max-age')) return true;
  return fallback;
}

/**
 * The Cache-Control to send instead, or null to leave the response as is.
 * request: { authorization: boolean, cookies: string[] } (cookie names).
 * response: { cacheControl: string | undefined, expires?: string, setCookie: boolean, statusCode?: number }.
 */
export function guardCacheControl(request, response) {
  // A response that sets cookies is never stored by a shared cache: it is
  // left alone when it is already private or no-store (keeping its browser
  // caching), else made private, no-store.
  if (response.setCookie) {
    const names = String(response.cacheControl ?? '').split(',').map((d) => d.split('=')[0].trim().toLowerCase());
    return names.includes('private') || names.includes('no-store') ? null : PRIVATE;
  }
  if (!request) return null;
  const credentialed =
    (request.authorization && !KEY_HEADERS.has('authorization')) ||
    (!ALL_COOKIES_KEYED && request.cookies.some((name) => !KEY_COOKIES.has(name)));
  if (!credentialed || !sharedCacheable(response.cacheControl, response.expires, response.statusCode)) return null;
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
    headerValues(target.headers, 'set-cookie').some((v) => v !== '') ||
    headerValues(target.multiValueHeaders, 'set-cookie').some((v) => v !== '') ||
    (Array.isArray(target.cookies) && target.cookies.some((v) => v != null && String(v) !== ''));
  const next = guardCacheControl(request, {
    cacheControl: cacheControl.length ? cacheControl.join(', ') : undefined,
    expires,
    setCookie,
    statusCode: target.statusCode,
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

// The fields of a response prelude. A first write on a stream with no content
// type is read as a prelude only when it is a JSON object with a numeric
// statusCode and no other fields, so an unframed body is passed on as is.
const PRELUDE_FIELDS = new Set(['statusCode', 'headers', 'multiValueHeaders', 'cookies']);

function isPrelude(value) {
  return typeof value.statusCode === 'number' && Object.keys(value).every((key) => PRELUDE_FIELDS.has(key));
}

// The most prelude bytes held back while a prelude written over several calls
// is completed; past it, the held bytes are passed on unchanged. A stream with
// no content type is not marked as framed, so less of it is held.
const PRELUDE_LIMIT = 64 * 1024;
const UNMARKED_PRELUDE_LIMIT = 8 * 1024;
// What guardPreludeChunk returns for bytes that may be the start of a prelude.
const MORE = Symbol('more');

// Whether JSON text that does not parse yet (it starts with '{') can still
// become a prelude: its first key, complete or not, must be (the start of) a
// prelude field. A key with an escape sequence is not decided here.
function mayBePrelude(text) {
  const rest = text.slice(1).trimStart();
  if (rest === '') return true;
  if (rest[0] !== '"') return false;
  const close = rest.indexOf('"', 1);
  const key = close === -1 ? rest.slice(1) : rest.slice(1, close);
  if (key.includes('\\\\')) return true;
  if (close !== -1) return PRELUDE_FIELDS.has(key);
  for (const field of PRELUDE_FIELDS) if (field.startsWith(key)) return true;
  return false;
}

function toBuffer(chunk, encoding) {
  if (typeof chunk === 'string') return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  return ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : Buffer.from(chunk);
}

// Guard the prelude at the start of the bytes a handler wrote. They may also
// carry the 8-NUL delimiter and the start of the body: only the part before
// the first NUL is the JSON prelude, and the rest is passed on byte for byte.
// With strict set (no content type marks the stream), the JSON must have the
// prelude's shape. Returns the bytes to write, or MORE when they have no NUL
// yet and may be the start of a JSON prelude.
function guardPreludeChunk(chunk, request, strict) {
  try {
    const isString = typeof chunk === 'string';
    const bytes = isString ? null : toBuffer(chunk);
    const nul = isString ? chunk.indexOf('\\u0000') : bytes.indexOf(0);
    const head = isString ? (nul === -1 ? chunk : chunk.slice(0, nul)) : (nul === -1 ? bytes : bytes.subarray(0, nul)).toString('utf8');
    const text = head.trimStart();
    if (text !== '' && text[0] !== '{') return chunk;
    let prelude;
    try {
      prelude = JSON.parse(head);
    } catch {
      // With strict set, bytes that can no longer be a prelude are passed on
      // at once instead of being held.
      if (nul === -1 && strict && !mayBePrelude(text)) return chunk;
      return nul === -1 ? MORE : chunk;
    }
    if (!prelude || typeof prelude !== 'object' || Array.isArray(prelude)) return chunk;
    if (strict && !isPrelude(prelude)) return chunk;
    const json = JSON.stringify(guardHeaders(prelude, request));
    if (nul === -1) return json;
    return isString ? json + chunk.slice(nul) : Buffer.concat([Buffer.from(json, 'utf8'), bytes.subarray(nul)]);
  } catch {
    return chunk;
  }
}

/**
 * Guard a response stream whose prelude the handler writes itself: the JSON
 * prelude written first after setContentType(<http-integration-response>),
 * and also when no content type is set at all, as behind an API Gateway
 * streaming integration (which frames every response with a prelude, so a
 * handler built for it may not set the marker). In that case the bytes are
 * read as a prelude only when they have the prelude's shape. A stream with
 * another content type, or whose prelude HttpResponseStream.from already
 * guarded, is skipped, so a body chunk is never read as a prelude.
 *
 * The prelude may come in one write() or end(chunk), or over several: the
 * bytes are held back until they hold a complete JSON object or a NUL (at most
 * PRELUDE_LIMIT bytes, or UNMARKED_PRELUDE_LIMIT with no content type), then
 * written in one call. With no content type, bytes whose first JSON key is not
 * a prelude field are passed on at once. An empty chunk is passed on without
 * deciding anything, and the body after the prelude is never held.
 */
export function guardStream(stream, request) {
  if (!stream || typeof stream.write !== 'function') return stream;
  // undefined until the handler sets a content type, then the last one set.
  let contentType;
  let done = false;
  // Prelude bytes held back, and the write callbacks waiting on them.
  let held = [];
  let heldBytes = 0;
  let heldCallbacks = [];
  const setContentType = stream.setContentType;
  if (typeof setContentType === 'function') {
    stream.setContentType = function (type) {
      contentType = String(type);
      return setContentType.apply(this, arguments);
    };
  }
  const takeHeld = () => {
    const callbacks = heldCallbacks;
    held = [];
    heldBytes = 0;
    heldCallbacks = [];
    return callbacks.length ? (err) => { for (const cb of callbacks) cb(err); } : undefined;
  };
  // What to write for this chunk: { chunk, encoding, callback }, the held bytes
  // in front of it; or undefined when it is held back too.
  const take = (chunk, encoding, callback) => {
    if (done) return { chunk, encoding, callback };
    const inspect = !guardedStreams.has(stream) && (contentType === undefined || contentType === PRELUDE_TYPE);
    if (!inspect && !held.length) {
      done = true;
      return { chunk, encoding, callback };
    }
    if (inspect && !held.length && (chunk == null || (chunk.length ?? chunk.byteLength) === 0)) {
      return { chunk, encoding, callback };
    }
    // A string in another encoding is read as the bytes it stands for.
    const own = typeof chunk === 'string' && (encoding === undefined || /^utf-?8$/i.test(encoding));
    const whole = held.length || !own ? Buffer.concat([...held, toBuffer(chunk, encoding)]) : chunk;
    const out = inspect ? guardPreludeChunk(whole, request, contentType === undefined) : whole;
    if (out === MORE) {
      const size = toBuffer(chunk, encoding).length;
      const limit = contentType === undefined ? UNMARKED_PRELUDE_LIMIT : PRELUDE_LIMIT;
      if (heldBytes + size <= limit) {
        held.push(toBuffer(chunk, encoding));
        heldBytes += size;
        if (typeof callback === 'function') heldCallbacks.push(callback);
        return undefined;
      }
    }
    done = true;
    const waiting = takeHeld();
    const merged = waiting && typeof callback === 'function' ? (err) => { waiting(err); callback(err); } : waiting ?? callback;
    const result = out === MORE ? whole : out;
    // The caller's encoding applies only to its own string passed on
    // unchanged; a rewritten prelude is UTF-8 JSON text.
    const resultEncoding = typeof result !== 'string' ? undefined : result === chunk ? encoding : 'utf8';
    return { chunk: result, encoding: resultEncoding, callback: merged };
  };
  // write(chunk, [encoding], [callback]) and end([chunk], [encoding], [callback]).
  const splitArgs = (args) => {
    const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    const encoding = typeof args[1] === 'string' ? args[1] : undefined;
    return { chunk: typeof args[0] === 'function' ? undefined : args[0], encoding, callback };
  };
  const write = stream.write;
  const writeArgs = (next) => [next.chunk, ...(next.encoding ? [next.encoding] : []), ...(next.callback ? [next.callback] : [])];
  // Stop inspecting and pass the held bytes on unchanged (never fail a
  // response because of the guard).
  const flushHeld = (target) => {
    done = true;
    if (held.length) write.call(target, Buffer.concat(held), ...[takeHeld()].filter(Boolean));
  };
  stream.write = function (...args) {
    if (done) return write.apply(this, args);
    const { chunk, encoding, callback } = splitArgs(args);
    let next;
    try {
      next = take(chunk, encoding, callback);
    } catch {
      flushHeld(this);
      return write.apply(this, args);
    }
    if (!next) return true;
    return write.call(this, ...writeArgs(next));
  };
  const end = stream.end;
  if (typeof end === 'function') {
    stream.end = function (...args) {
      if (done) return end.apply(this, args);
      const { chunk, encoding, callback } = splitArgs(args);
      if (chunk == null) {
        flushHeld(this);
        return end.apply(this, args);
      }
      let next;
      try {
        next = take(chunk, encoding, undefined);
      } catch {
        flushHeld(this);
        return end.apply(this, args);
      }
      // Bytes still held at the end are not a prelude: passed on unchanged.
      if (!next) {
        flushHeld(this);
        return end.call(this, ...(callback ? [callback] : []));
      }
      done = true;
      if (next.callback) {
        write.call(this, ...writeArgs(next));
        return end.call(this, ...(callback ? [callback] : []));
      }
      return end.call(this, ...writeArgs({ ...next, callback }));
    };
  }
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
        // An empty Set-Cookie value (e.g. setHeader('Set-Cookie', []), which a
        // server may call for every response) sends no header, so it does not count.
        const currentSetCookie = this.getHeader('set-cookie');
        const setCookie =
          fromArgs('set-cookie').some((v) => v !== '') ||
          (currentSetCookie != null && [].concat(currentSetCookie).some((v) => String(v) !== ''));
        const request = {
          authorization: req.headers.authorization != null,
          cookies: [...new Set(cookieNames(req.headers.cookie))],
        };
        const next = guardCacheControl(request, { cacheControl, expires, setCookie, statusCode });
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

// A module without a matching handler export is passed through unchanged, so
// the runtime reports its own missing-handler error instead of the wrapper
// failing while the module loads.
export const handler = typeof run !== 'function'
  ? run
  : run[STREAMING]
  ? function (event, responseStream, ...rest) {
      const request = requestInfoFromEvent(event);
      return runWithRequest(request, () => run.call(this, event, guardStream(responseStream, request), ...rest));
    }
  : run.length >= 3
  ? // A callback-style handler (event, context, callback) reports its result
    // through the callback, so the wrapper guards it there. It keeps the
    // handler's arity and return value, so the runtime invokes it the same way.
    function (event, context, callback, ...rest) {
      const request = requestInfoFromEvent(event);
      const done =
        typeof callback === 'function' ? (err, res) => callback(err, err ? res : guardResult(res, request)) : callback;
      const out = run.call(this, event, context, done, ...rest);
      return out && typeof out.then === 'function' ? out.then((res) => guardResult(res, request)) : out;
    }
  : async function (event, ...rest) {
      const request = requestInfoFromEvent(event);
      return guardResult(await run.call(this, event, ...rest), request);
    };
// A streaming handler (awslambda.streamifyResponse) is marked with symbols the
// runtime reads; the wrapper carries them so it is invoked the same way.
if (typeof run === 'function' && handler !== run) {
  for (const key of Object.getOwnPropertySymbols(run)) handler[key] = run[key];
}
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
  const target = resolveHandlerModule(resource.bundle, handler);
  if (!target) return { resource, skipped: `the handler '${handler}' does not name a module and an export` };
  const { moduleBase, exportName, moduleFile } = target;
  if (!moduleFile) return { resource, skipped: `the handler module '${moduleBase}' (.mjs/.js/.cjs) is not in the bundle` };
  writeIfChanged(path.join(resource.bundle, SSR_CACHE_GUARD_FILE), guardCode);
  writeIfChanged(
    path.join(resource.bundle, SSR_CACHE_GUARD_HANDLER_FILE),
    generateSsrCacheGuardHandlerCode(`./${moduleFile}`, exportName),
  );
  return { resource: { ...resource, handler: SSR_CACHE_GUARD_HANDLER } };
};
