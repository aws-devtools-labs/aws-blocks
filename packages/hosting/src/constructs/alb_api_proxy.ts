import { type ProxyRules, proxyRulesJs } from './proxy_rules.js';

/**
 * API-proxy Lambda for the ALB front door (same-origin `/aws-blocks/*`).
 *
 * On CloudFront the same-origin API proxy is a cache behavior forwarding
 * `/aws-blocks/*` (+ the auth subtree) to the backend API Gateway. An ALB
 * cannot target an external HTTPS URL directly, so this tiny Lambda TARGET
 * forwards the request to the API Gateway base URL and relays the response —
 * keeping the API same-origin with the frontend (so `SameSite=Lax` session
 * cookies flow and there is no CORS). It is the ALB analogue of
 * `addApiBehaviors` on CloudFront.
 *
 * ALB↔Lambda contract with multi-value headers (the target group enables
 * `multiValueHeadersEnabled` so multiple `Set-Cookie` response headers survive):
 * event has `path, httpMethod, multiValueHeaders, multiValueQueryStringParameters,
 * body, isBase64Encoded`; the response uses `statusCode, statusDescription,
 * multiValueHeaders, body, isBase64Encoded`.
 *
 * Emitted INLINE (no bundle step) — uses only Node's built-in `https`.
 *
 * The API Gateway base URL is passed via the `API_GW_BASE` env var (NOT baked
 * into the code) because it is a CloudFormation token at synth. It is the API
 * Gateway origin base WITHOUT the `/aws-blocks/api` suffix (e.g.
 * `https://abc.execute-api.us-west-2.amazonaws.com/prod`); the forwarder appends
 * the request path verbatim.
 *
 * It applies the app's per-pattern response headers (`opts.headers`) to a
 * successful (status below 400) response, matched by the edge router's own
 * code (see `proxy_rules.ts`) — as the CloudFront door's viewer-response
 * function does for the API behaviors.
 *
 * Request hygiene: query pairs go upstream exactly as the ALB delivered them
 * (the ALB does not decode them, so re-encoding would double-encode); several
 * `Cookie` fields are joined with `; `; the router's origin-verify secret and
 * client-supplied forwarding headers (`x-forwarded-host`, `-proto`, `-port`)
 * are stripped, while the ALB-appended `x-forwarded-for` chain and the
 * `x-amzn-trace-id` pass through. Hop-by-hop response headers are dropped; a
 * text response goes back as UTF-8 (so the 1 MB ALB response cap is not cut
 * by base64), a binary one as base64. An unreachable backend answers a fixed
 * `502 {"error":"Bad Gateway"}` and logs the cause, never echoing it.
 *
 * @param opts.headers the app's header rules. @default none
 */
export const generateAlbApiProxyCode = (opts: Pick<ProxyRules, 'headers'> = {}): string => {
  return `const https = require('node:https');
${proxyRulesJs({ headers: opts.headers })}
const BASE = (process.env.API_GW_BASE || '').replace(/\\/+$/, ''); // https://<id>.execute-api.<region>.amazonaws.com/prod
const target = new URL(BASE);

// Request headers never forwarded upstream: hop-by-hop, the ones this
// forwarder sets itself, the router's origin-verify secret, and client-supplied
// forwarding headers the backend would otherwise trust (a loopback
// x-forwarded-host is the dev-server signal). The ALB-appended
// x-forwarded-for chain and x-amzn-trace-id pass through.
const STRIP = { 'host': 1, 'content-length': 1, 'connection': 1, 'keep-alive': 1, 'proxy-connection': 1, 'te': 1, 'trailer': 1, 'transfer-encoding': 1, 'upgrade': 1, 'x-forwarded-host': 1, 'x-forwarded-proto': 1, 'x-forwarded-port': 1, 'x-blocks-origin-verify': 1 };
// Hop-by-hop response headers never relayed back to the ALB.
const STRIP_RESPONSE = { 'connection': 1, 'keep-alive': 1, 'proxy-connection': 1, 'te': 1, 'trailer': 1, 'transfer-encoding': 1, 'upgrade': 1 };
// Content types relayed as UTF-8 text rather than base64.
const TEXT_TYPE = /^(text\\/|application\\/(json|javascript|xml|x-www-form-urlencoded|[\\w.+-]*\\+(json|xml))\\b)/i;

// The ALB delivers query keys and values still percent-encoded, so the pairs
// go upstream as delivered (re-encoding would turn %20 into %2520).
function rawQuery(mv) {
  if (!mv) return '';
  var parts = [];
  for (var k in mv) { var vals = mv[k]; for (var i = 0; i < vals.length; i++) parts.push(k + '=' + vals[i]); }
  return parts.length ? '?' + parts.join('&') : '';
}

exports.handler = async (event) => {
  var path = event.path || '/';
  var qs = rawQuery(event.multiValueQueryStringParameters || null);
  // Upstream path = API Gateway stage base path + the request path.
  var upstreamPath = (target.pathname.replace(/\\/+$/, '')) + path + qs;

  var headers = {};
  var mvh = event.multiValueHeaders || {};
  for (var name in mvh) {
    var lower = name.toLowerCase();
    if (STRIP[lower]) continue;
    headers[name] = mvh[name].join(lower === 'cookie' ? '; ' : ', ');
  }
  headers['host'] = target.host;

  var bodyBuf = event.body == null ? null : Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  // The client's content-length was stripped with the hop-by-hop set; send the
  // relayed body's own length, so the request is never chunked (API Gateway
  // and some backends reject or mis-read a chunked body with no length).
  if (bodyBuf) headers['content-length'] = String(bodyBuf.length);

  return await new Promise((resolve) => {
    var req = https.request({
      hostname: target.hostname,
      port: 443,
      method: event.httpMethod || 'GET',
      path: upstreamPath,
      headers: headers,
    }, (res) => {
      var chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        var buf = Buffer.concat(chunks);
        // Relay response headers as multi-value so multiple Set-Cookie survive.
        var outMv = {};
        for (var h in res.headers) {
          if (STRIP_RESPONSE[h.toLowerCase()]) continue;
          var v = res.headers[h];
          outMv[h] = Array.isArray(v) ? v : [String(v)];
        }
        // The app's header rules, on a successful response (as at the edge).
        if ((res.statusCode || 502) < 400) {
          var rule = blocksHeaders(path);
          for (var r in rule) outMv[r] = [rule[r]];
        }
        // Text goes back as UTF-8 when its bytes round-trip, so base64 does not
        // inflate it by 4/3 against the ALB's 1 MB response cap.
        var type = String(res.headers['content-type'] || '');
        var text = TEXT_TYPE.test(type) ? buf.toString('utf8') : null;
        var asText = text !== null && Buffer.from(text, 'utf8').equals(buf);
        resolve({
          statusCode: res.statusCode || 502,
          statusDescription: (res.statusCode || 502) + ' ' + (res.statusMessage || ''),
          multiValueHeaders: outMv,
          isBase64Encoded: !asText,
          body: asText ? text : buf.toString('base64'),
        });
      });
    });
    req.on('error', (err) => {
      // Logged for the operator; never echoed (it names the backend host).
      console.error('api-proxy upstream error', err);
      resolve({
        statusCode: 502,
        statusDescription: '502 Bad Gateway',
        multiValueHeaders: { 'content-type': ['application/json'] },
        isBase64Encoded: false,
        body: '{"error":"Bad Gateway"}',
      });
    });
    req.end(bodyBuf || undefined);
  });
};
`;
};
