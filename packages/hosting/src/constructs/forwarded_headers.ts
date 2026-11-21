// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forwarded headers the server can trust: the public host, the scheme and the
 * client address, as the door in front of the server set them.
 *
 * Behind a front door the server's own view of a request is an internal one:
 * `Host` names the origin (the REST API, the Web Function endpoint, the
 * router's ALB), the socket's peer is a proxy, and `X-Forwarded-For` starts
 * with whatever the client sent. Each built-in door sets or appends some of
 * these headers itself, so Hosting knows which values come from the door:
 *
 * | Door | Public host | Client address | Scheme |
 * |---|---|---|---|
 * | CloudFront (REST API or Web Function origin) | `x-forwarded-host` (the router sets it from the viewer's `Host`, over any client value) | 2nd entry from the right of `X-Forwarded-For` (CloudFront appends the viewer, the origin appends CloudFront) | `x-forwarded-proto` (set by the origin) |
 * | Stacked (CloudFront edge over the ALB router) | `x-forwarded-host` (the edge sets it) | 2nd entry from the right (CloudFront appends the viewer, the ALB appends CloudFront) | `cloudfront-forwarded-proto` (the edge → router hop may be plain HTTP) |
 * | ALB | `Host` | right-most entry (the ALB appends the client) | `x-forwarded-proto` (the ALB sets it from its listener) |
 * | API Gateway (HTTP or REST) | `Host` (the API's domain or the custom domain) | right-most entry (API Gateway appends the client) | `x-forwarded-proto` (set by API Gateway) |
 *
 * Each origin admits only its door (the REST API checks the origin-verify
 * header, the Web Function endpoint signs with origin access control, the
 * stacked router checks the edge's header), so the right-most entries can't
 * come from a client. The left-most entries can, and are never used.
 *
 * Before the server sees a request, Hosting rewrites it from those values:
 * `Host` and `x-forwarded-host` both name the public host, `X-Forwarded-For`
 * holds only the client address, and `x-forwarded-proto` the viewer's scheme;
 * on a Lambda event, `requestContext.identity.sourceIp` /
 * `requestContext.http.sourceIp` are the client address too. A framework
 * then reads the right values whichever header it trusts (SvelteKit's
 * `HOST_HEADER`/`ADDRESS_HEADER` with `XFF_DEPTH=1`, Nitro's `Host` and
 * `getRequestIP(event, { xForwardedFor: true })`, Astro once
 * `security.allowedDomains` names the host).
 *
 * The rewrite ships in the SSR cache guard module (`ssr_cache_guard.ts`), which
 * is already loaded in front of every server shape: a Node HTTP server (it
 * patches `http.Server#emit` for `request` events) and a native Lambda handler
 * (the handler wrapper rewrites the event). A bring-your-own door, and
 * `frontDoor: 'none'`, get no rewrite: what reaches the server there is the
 * door author's to define.
 *
 * @module
 * @internal Framework-only.
 */

/** Which forwarded headers come from the door (see the module docs). */
export interface ForwardedHeadersTrust {
  /**
   * The `X-Forwarded-For` entry, counted from the right (1 = right-most),
   * that the door appended for the client.
   */
  readonly clientHop: number;
  /** The header that carries the public host. */
  readonly hostHeader: 'x-forwarded-host' | 'host';
  /** A header the door sets with the viewer's scheme, over `x-forwarded-proto`. */
  readonly protoHeader?: string;
}

/** The CloudFront door (and a Web Function, which is only reachable through it). */
export const CLOUDFRONT_FORWARDED_TRUST: ForwardedHeadersTrust = { clientHop: 2, hostHeader: 'x-forwarded-host' };
/** The stacked door: CloudFront edge over the ALB router. */
export const STACKED_FORWARDED_TRUST: ForwardedHeadersTrust = {
  clientHop: 2,
  hostHeader: 'x-forwarded-host',
  protoHeader: 'cloudfront-forwarded-proto',
};
/** The ALB and API Gateway doors: the viewer talks to the origin directly. */
export const DIRECT_FORWARDED_TRUST: ForwardedHeadersTrust = { clientHop: 1, hostHeader: 'host' };

/**
 * The forwarded-headers trust of a built-in door, or undefined for a
 * bring-your-own door and `'none'`.
 *
 * @param kind the door kind (`undefined` or `'cloudfront'` for the default door).
 * @returns the trust, or undefined to leave requests as they arrive.
 */
export const forwardedHeadersTrustFor = (kind: string | undefined): ForwardedHeadersTrust | undefined => {
  switch (kind) {
    case undefined:
    case 'cloudfront':
      return CLOUDFRONT_FORWARDED_TRUST;
    case 'stackedRouter':
      return STACKED_FORWARDED_TRUST;
    case 'alb':
    case 'apiGateway':
      return DIRECT_FORWARDED_TRUST;
    default:
      return undefined;
  }
};

/**
 * The runtime code (ES module source, no imports beyond `node:http`, which
 * the including module imports as `http`) that rewrites forwarded headers:
 * exports `forwardedValues`, `normalizeForwardedEvent` and
 * `normalizeForwardedNodeRequest`, and patches `http.Server#emit` when
 * evaluated. With no trust, the exports leave every request as it is.
 *
 * @param trust the door's trust, or undefined.
 * @returns the source, to be embedded in a module that imports `node:http` as `http`.
 */
export const generateForwardedHeadersCode = (trust: ForwardedHeadersTrust | undefined): string => `
// ---- Forwarded headers: the public host, scheme and client address the door set ----
const FORWARDED = ${JSON.stringify(trust ?? null)};
const FORWARDED_INSTALLED = Symbol.for('aws-blocks.hosting.forwarded-headers');
const FORWARDED_NAMES = ['host', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto'];

function firstValue(value) {
  if (value == null) return undefined;
  const text = String([].concat(value)[0]).split(',')[0].trim();
  return text === '' ? undefined : text;
}

/**
 * The values to set, from a header lookup (lower-case name -> value or
 * undefined): { host?, 'x-forwarded-host'?, 'x-forwarded-for'?, 'x-forwarded-proto'? },
 * where null removes the header and a missing key leaves it. Null when there
 * is nothing to rewrite.
 */
export function forwardedValues(get) {
  if (!FORWARDED) return null;
  const out = {};
  const host = firstValue(get(FORWARDED.hostHeader));
  if (host !== undefined) {
    out.host = host;
    out['x-forwarded-host'] = host;
  } else if (FORWARDED.hostHeader === 'host') {
    // A client-sent x-forwarded-host never reaches the server.
    out['x-forwarded-host'] = null;
  }
  // The door appended the client FORWARDED.clientHop entries from the right;
  // anything to its left came from the client. With fewer entries, the
  // left-most one was still appended by the door's own hop.
  const raw = get('x-forwarded-for');
  const entries = raw == null ? [] : [].concat(raw).join(',').split(',').map((e) => e.trim()).filter((e) => e !== '');
  out['x-forwarded-for'] = entries.length === 0 ? null : entries[Math.max(0, entries.length - FORWARDED.clientHop)];
  if (FORWARDED.protoHeader) {
    const proto = firstValue(get(FORWARDED.protoHeader));
    if (proto !== undefined && /^https?$/i.test(proto)) out['x-forwarded-proto'] = proto.toLowerCase();
  }
  return out;
}

function eventLookup(event) {
  return (name) => {
    for (const map of [event.multiValueHeaders, event.headers]) {
      if (!map) continue;
      for (const key of Object.keys(map)) {
        if (key.toLowerCase() === name && map[key] != null) return map[key];
      }
    }
    return undefined;
  };
}

function setEventHeader(map, name, value, multi) {
  if (!map) return;
  for (const key of Object.keys(map)) if (key.toLowerCase() === name) delete map[key];
  if (value !== null) map[name] = multi ? [value] : value;
}

/** Rewrite a Lambda event's forwarded headers (and source IP) in place. */
export function normalizeForwardedEvent(event) {
  if (!event || typeof event !== 'object' || (!event.headers && !event.multiValueHeaders)) return event;
  const values = forwardedValues(eventLookup(event));
  if (!values) return event;
  for (const name of FORWARDED_NAMES) {
    if (!(name in values)) continue;
    setEventHeader(event.headers, name, values[name], false);
    setEventHeader(event.multiValueHeaders, name, values[name], true);
  }
  const ip = values['x-forwarded-for'];
  const context = event.requestContext;
  if (ip && context && typeof context === 'object') {
    if (context.identity && typeof context.identity === 'object' && 'sourceIp' in context.identity) context.identity.sourceIp = ip;
    if (context.http && typeof context.http === 'object' && 'sourceIp' in context.http) context.http.sourceIp = ip;
  }
  return event;
}

/** Rewrite a Node.js request's forwarded headers (headers and rawHeaders) in place. */
export function normalizeForwardedNodeRequest(req) {
  const headers = req.headers;
  const values = forwardedValues((name) => headers[name]);
  if (!values) return req;
  const raw = Array.isArray(req.rawHeaders) ? req.rawHeaders : null;
  const rawOut = [];
  if (raw) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (!(String(raw[i]).toLowerCase() in values)) rawOut.push(raw[i], raw[i + 1]);
    }
  }
  for (const name of FORWARDED_NAMES) {
    if (!(name in values)) continue;
    if (values[name] === null) delete headers[name];
    else {
      headers[name] = values[name];
      rawOut.push(name, values[name]);
    }
  }
  if (raw) raw.splice(0, raw.length, ...rawOut);
  return req;
}

function installForwardedHeaders() {
  if (!FORWARDED) return;
  // One install per process; the last module evaluated decides the trust.
  globalThis[FORWARDED_INSTALLED] = normalizeForwardedNodeRequest;
  const proto = http.Server.prototype;
  if (proto[FORWARDED_INSTALLED]) return;
  proto[FORWARDED_INSTALLED] = true;
  const emit = proto.emit;
  proto.emit = function (type, req, ...rest) {
    if (type === 'request' && req && req.headers) {
      try {
        globalThis[FORWARDED_INSTALLED](req);
      } catch {
        // Never fail a request because of the rewrite.
      }
    }
    return emit.call(this, type, req, ...rest);
  };
}

installForwardedHeaders();
`;
