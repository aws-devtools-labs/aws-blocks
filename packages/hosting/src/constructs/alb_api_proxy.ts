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
 */
export const generateAlbApiProxyCode = (): string => {
  return `const https = require('node:https');
const BASE = (process.env.API_GW_BASE || '').replace(/\\/+$/, ''); // https://<id>.execute-api.<region>.amazonaws.com/prod
const target = new URL(BASE);

// Hop-by-hop / ALB-injected headers that must NOT be forwarded upstream.
const STRIP = { 'host': 1, 'content-length': 1, 'connection': 1, 'x-forwarded-for': 1, 'x-forwarded-proto': 1, 'x-forwarded-port': 1, 'x-amzn-trace-id': 1 };

function firstQuery(mv) {
  if (!mv) return '';
  var parts = [];
  for (var k in mv) { var vals = mv[k]; for (var i = 0; i < vals.length; i++) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(vals[i])); }
  return parts.length ? '?' + parts.join('&') : '';
}

exports.handler = async (event) => {
  var path = event.path || '/';
  var qs = firstQuery(event.multiValueQueryStringParameters || null);
  // Upstream path = API Gateway stage base path + the request path.
  var upstreamPath = (target.pathname.replace(/\\/+$/, '')) + path + qs;

  var headers = {};
  var mvh = event.multiValueHeaders || {};
  for (var name in mvh) {
    if (STRIP[name.toLowerCase()]) continue;
    headers[name] = mvh[name].join(', ');
  }
  headers['host'] = target.host;

  var bodyBuf = event.body == null ? null : Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');

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
          var v = res.headers[h];
          outMv[h] = Array.isArray(v) ? v : [String(v)];
        }
        resolve({
          statusCode: res.statusCode || 502,
          statusDescription: (res.statusCode || 502) + ' ' + (res.statusMessage || ''),
          multiValueHeaders: outMv,
          isBase64Encoded: true,
          body: buf.toString('base64'),
        });
      });
    });
    req.on('error', (err) => {
      resolve({
        statusCode: 502,
        statusDescription: '502 Bad Gateway',
        multiValueHeaders: { 'content-type': ['application/json'] },
        isBase64Encoded: false,
        body: JSON.stringify({ error: 'api-proxy upstream error', message: String(err && err.message || err) }),
      });
    });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
};
`;
};
