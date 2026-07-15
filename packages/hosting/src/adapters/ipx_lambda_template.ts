/**
 * Source for the IPX Lambda handler the Nitro adapter materialises
 * into the user's project at the image-optimization output directory
 * before the L3 deploy reads from it.
 *
 * Inlined as a string so the template ships inside the compiled
 * package (TypeScript only copies `.ts`/`.js`, not `.mjs`).
 *
 * Runtime contract:
 *   - The Lambda exposes `handler(event)` for AWS Lambda Function URL
 *     invocations.
 *   - Originals are fetched directly from S3 (the static-assets bucket
 *     the L3 provisioned) via the AWS SDK + Lambda execution role.
 *     We use a custom IPX storage adapter rather than ipxHttpStorage
 *     to avoid a circular CDK dependency on the CloudFront distribution.
 *
 * Env vars set by the L3 construct:
 *   - `BUCKET_NAME` — static-assets S3 bucket name (already injected
 *     by the L3 today for OpenNext compat).
 *   - `BUCKET_REGION` — bucket region.
 *   - `BUCKET_KEY_PREFIX` — `builds/<buildId>` prefix that namespaces
 *     this deploy's assets.
 *
 * SVG handling:
 *   IPX runs SVG inputs through SVGO (the upstream default; we don't
 *   override `svgo: false`). The output is a minified SVG, not a
 *   raster — sharp can't write SVG, so `?f=webp` etc. on an SVG
 *   source isn't meaningful. Users sometimes mistake "same visual,
 *   different bytes" for "no optimization" — it isn't, SVGO did its
 *   work. Upstream tracks broader format support in
 *   https://github.com/unjs/ipx/issues/261.
 */
export const IPX_LAMBDA_HANDLER_SOURCE = `import { createIPX, createIPXWebServer, ipxHttpStorage } from 'ipx';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Buffer } from 'node:buffer';

const bucket = process.env.BUCKET_NAME;
const region = process.env.BUCKET_REGION;
const keyPrefix = process.env.BUCKET_KEY_PREFIX || '';

if (!bucket || !region) {
  throw new Error(
    'BUCKET_NAME / BUCKET_REGION not set — image-optimization Lambda has no upstream to fetch originals from.',
  );
}

const s3 = new S3Client({ region });

// ---- Allowlist enforcement ---------------------------------------------
// The construct stamps these env vars from \`manifest.imageOptimization\`
// (\`hosting_construct.ts\` § "Image-opt safety knobs"). Without runtime
// enforcement here, a viewer could request optimization of any URL the
// Lambda can reach (incl. internal VPC hosts), turning the optimizer
// into an SSRF primitive. We default-deny: env unset means "no remote
// fetches allowed" so a misconfiguration fails closed instead of open.
const allowSvg = (process.env.IMAGE_ALLOW_SVG || '').toLowerCase() === 'true';

let parsedRemotePatterns = [];
const rawPatterns = process.env.IMAGE_REMOTE_PATTERNS;
if (rawPatterns) {
  try {
    const arr = JSON.parse(rawPatterns);
    if (Array.isArray(arr)) {
      parsedRemotePatterns = arr.filter(
        (p) => p && typeof p === 'object' && typeof p.hostname === 'string',
      );
    }
  } catch {
    // Malformed env value: keep allowlist empty (default-deny). The
    // construct synthesizes valid JSON so a parse failure here means
    // tampering or future-incompat — fail closed.
    parsedRemotePatterns = [];
  }
}

// Optional simpler shape, kept for parity with Astro \`image.domains\`
// + Next.js \`images.domains\`. CSV string of bare hostnames.
const allowedHostnames = (process.env.IMAGE_ALLOWED_HOSTNAMES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const matchHostname = (host, pattern) => {
  if (!pattern) return false;
  // Wildcard prefix: "*.example.com" matches "foo.example.com" but not
  // "example.com" (mirrors Next.js semantics).
  if (pattern.startsWith('*.')) {
    return host.endsWith(pattern.slice(1)) && host !== pattern.slice(2);
  }
  return host === pattern;
};

// Path-prefix matcher used by remote-source allowlisting. A naive
// \`startsWith\` lets \`/images\` match \`/images-secret/anything\`, which
// would let a viewer bypass intent — anchor at a path-segment boundary
// instead. \`ptn === pathname\` covers exact matches; \`startsWith(ptn + '/')\`
// covers descendants. \`/**\` wildcard patterns are stripped before being
// passed in (see caller).
const matchPathPrefix = (pathname, ptn) => {
  if (!ptn || ptn === '/') return true;
  // Drop any trailing slash so '/images/' and '/images' behave the same.
  const norm = ptn.endsWith('/') ? ptn.slice(0, -1) : ptn;
  return pathname === norm || pathname.startsWith(norm + '/');
};

const isRemoteSourceAllowed = (rawSrc) => {
  let parsed;
  try {
    parsed = new URL(rawSrc);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  // \`username\`/\`password\` (the userinfo component) lets attackers
  // smuggle hosts past a naive hostname check via shapes like
  // \`https://allowed.com@evil.com/...\` — the hostname is \`evil.com\`,
  // not \`allowed.com\`, but the visible string suggests otherwise to
  // a casual reader. \`URL.hostname\` already strips userinfo for the
  // matching step below, but reject these outright so we never log
  // a misleading \`reject remote: <misleading-string>\` line.
  if (parsed.username || parsed.password) {
    return false;
  }
  const host = parsed.hostname;
  if (allowedHostnames.some((h) => matchHostname(host, h))) return true;
  for (const p of parsedRemotePatterns) {
    if (!matchHostname(host, p.hostname)) continue;
    if (p.protocol && p.protocol + ':' !== parsed.protocol) continue;
    if (p.port && p.port !== parsed.port) continue;
    if (p.pathname) {
      // Next.js pathname patterns allow trailing /** wildcard. Strip
      // it and delegate to a segment-boundary-aware matcher.
      const ptn = p.pathname.endsWith('/**')
        ? p.pathname.slice(0, -3)
        : p.pathname;
      if (!matchPathPrefix(parsed.pathname, ptn)) continue;
    }
    return true;
  }
  return false;
};

const isLocalSourceAllowed = (id) => {
  // Local paths begin with "/" and resolve to S3 keys under the build
  // prefix. They are always permitted — IPX storage adapter only sees
  // keys under \`builds/<id>/\` so cross-build snooping is impossible.
  return typeof id === 'string' && id.startsWith('/');
};

const isSvgPath = (id) => /\\.svg(\\?|$)/i.test(String(id));


/**
 * Custom IPX storage adapter that reads originals from S3 using the
 * Lambda execution role (no static keys, no inter-construct CDK
 * dependency on the CloudFront distribution).
 */
const resolveKey = (id) => {
  const cleanKey = id.replace(/^\\//, '');
  return keyPrefix ? \`\${keyPrefix}/\${cleanKey}\` : cleanKey;
};

const s3IpxStorage = {
  name: 'hosting-s3-storage',
  async getMeta(id) {
    try {
      const res = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: resolveKey(id) }),
      );
      // IPX wants { mtime, maxAge?, size? }; mtime and size are
      // enough for ETag generation.
      return {
        mtime: res.LastModified ? res.LastModified.getTime() : undefined,
        size: res.ContentLength,
      };
    } catch (err) {
      if (err?.name === 'NoSuchKey' || err?.name === 'NotFound') return undefined;
      throw err;
    }
  },
  async getData(id) {
    try {
      const res = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: resolveKey(id) }),
      );
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (err?.name === 'NoSuchKey' || err?.name === 'NotFound') return undefined;
      throw err;
    }
  },
};

// Remote (http/https) sources need IPX's HTTP storage — without it IPX
// routes a remote id to the S3 \`storage\` above, which has no such key, so
// every allowlisted remote image 404s with IPX_RESOURCE_NOT_FOUND (issue #2).
// Configure \`httpStorage\` scoped to the SAME allowlist the handler enforces
// (hostnames from IMAGE_ALLOWED_HOSTNAMES + IMAGE_REMOTE_PATTERNS). IPX picks
// \`httpStorage\` for \`http(s)://\` ids and \`storage\` (S3) for local keys.
// \`isRemoteSourceAllowed\` still gates every request BEFORE IPX runs, so the
// domains list here is defense-in-depth, not the sole guard. Omit httpStorage
// entirely when no remote host is allowlisted (default-deny: local only).
const httpDomains = [
  ...allowedHostnames,
  ...parsedRemotePatterns.map((p) => p.hostname),
].filter(Boolean);

const ipx = createIPX({
  storage: s3IpxStorage,
  ...(httpDomains.length > 0
    ? { httpStorage: ipxHttpStorage({ domains: httpDomains }) }
    : {}),
});

const ipxServer = createIPXWebServer(ipx);

const log = (msg) =>
  process.stderr.write(\`[hosting:image] \${msg}\\n\`);

/**
 * Configurable base URL prefix the user wired into @nuxt/image. Defaults
 * to /_ipx, the @nuxt/image default. Users override via
 * \`runtimeConfig.ipx.baseURL\` in nuxt.config; the adapter forwards
 * that value into IPX_BASE_URL on this Lambda.
 */
const ipxBaseURL = (process.env.IPX_BASE_URL || '/_ipx').replace(/\\/+$/, '');
const ipxStripPattern = new RegExp(
  '^' + ipxBaseURL.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'),
);

/**
 * Rebuild a query string from API Gateway REST (v1) query params. Prefers
 * multiValue (preserves repeats).
 *
 * Why re-encode: API Gateway REST v1 delivers query values ALREADY
 * URL-DECODED in the (multiValue)queryStringParameters object (there is no
 * rawQueryString on a v1 event -- that field is v2-only). Re-applying
 * encodeURIComponent to each key/value rebuilds a valid, correctly-escaped
 * query string from those decoded values, so a remote source carrying
 * reserved chars (?, &, =, :// ) round-trips intact. This is NOT
 * double-encoding: we encode once, against values APIGW handed us decoded.
 */
const v1QueryString = (event) => {
  const mv = event.multiValueQueryStringParameters;
  if (mv && Object.keys(mv).length > 0) {
    const parts = [];
    for (const k of Object.keys(mv)) {
      for (const v of mv[k]) {
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      }
    }
    return parts.length ? '?' + parts.join('&') : '';
  }
  const sv = event.queryStringParameters;
  if (sv && Object.keys(sv).length > 0) {
    return (
      '?' +
      Object.keys(sv)
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(sv[k]))
        .join('&')
    );
  }
  return '';
};

/**
 * Convert a Lambda event into a standard fetch Request. Accepts BOTH:
 *   - API Gateway REST (v1): \`event.path\`, \`event.httpMethod\`,
 *     \`event.(multiValue)?queryStringParameters\` — used when the IPX
 *     Lambda is fronted by the SHARED SSR API Gateway (issue #2 fix, so
 *     a remote source's unencoded \`://\` in the path survives OAC/SigV4).
 *   - Lambda Function URL (v2): \`event.rawPath\`, \`event.rawQueryString\`,
 *     \`event.requestContext.http.method\` — the standalone fallback origin.
 *
 * Strips the configured base URL prefix because IPX's web server expects
 * paths in the shape /<modifiers>/<sourcePath> (without the prefix).
 */
const eventToRequest = (event) => {
  const isV1 = typeof event.rawPath !== 'string' && typeof event.path === 'string';
  const rawPath = (isV1 ? event.path : event.rawPath) || '/';
  const stripped = rawPath.replace(ipxStripPattern, '') || '/';
  const query = isV1
    ? v1QueryString(event)
    : event.rawQueryString
      ? \`?\${event.rawQueryString}\`
      : '';
  // The IPX server doesn't actually use the host part — it pulls path
  // and query from the URL. Use a placeholder.
  const url = new URL(stripped + query, 'http://image-opt.local');

  const method =
    (isV1 ? event.httpMethod : event.requestContext?.http?.method) || 'GET';
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers || {})) {
    if (typeof v === 'string') headers.set(k, v);
  }

  const body = event.body
    ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')
    : undefined;

  return new Request(url.toString(), { method, headers, body });
};

const responseToLambda = async (response) => {
  const arrayBuf = await response.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  const headers = {};
  for (const [k, v] of response.headers.entries()) headers[k] = v;
  return {
    statusCode: response.status,
    headers,
    body: buf.toString('base64'),
    isBase64Encoded: true,
  };
};

/**
 * IPX URL shape (post strip): \`/<modifiers>/<source>\`. \`<source>\` may
 * be a leading-\`/\` relative path (S3-served original) or an absolute
 * \`http(s)://\` URL (remote pattern). Extract \`<source>\` so we can
 * gate it against the allowlist.
 */
const extractIpxSource = (req) => {
  const url = new URL(req.url);
  // Drop the leading slash and the modifiers segment ("/_/", "/640x_/",
  // etc.). IPX also accepts the source as a query param in some
  // configurations — covered by the "rawSource" fallback below.
  const path = url.pathname.replace(/^\\/+/, '');
  const slash = path.indexOf('/');
  if (slash === -1) return undefined;
  const tail = path.slice(slash + 1);
  // tail is either an absolute URL or a relative S3 key.
  if (/^https?%3A/i.test(tail)) {
    try {
      return decodeURIComponent(tail);
    } catch {
      return tail;
    }
  }
  return tail.startsWith('http://') || tail.startsWith('https://')
    ? tail
    : '/' + tail;
};

const reject = (status, message) => ({
  statusCode: status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ error: message }),
});

export const handler = async (event) => {
  try {
    const req = eventToRequest(event);

    const source = extractIpxSource(req);
    if (!source) {
      return reject(400, 'invalid IPX URL');
    }
    if (isSvgPath(source) && !allowSvg) {
      // SVG can carry script payloads; reject unless the user opted
      // in via dangerouslyAllowSVG. Mirrors Next.js / Astro semantics.
      log(\`reject SVG: \${source}\`);
      return reject(415, 'SVG sources are not permitted');
    }
    if (source.startsWith('http://') || source.startsWith('https://')) {
      if (!isRemoteSourceAllowed(source)) {
        log(\`reject remote: \${source}\`);
        return reject(403, 'remote source not in allowlist');
      }
    } else if (!isLocalSourceAllowed(source)) {
      return reject(400, 'unsupported IPX source');
    }

    const res = await ipxServer(req);
    return await responseToLambda(res);
  } catch (err) {
    log(\`error: \${err?.message ?? err}\`);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'image optimization failed' }),
    };
  }
};
`;

export const IPX_LAMBDA_PACKAGE_JSON = JSON.stringify(
  {
    name: 'hosting-image-optimization',
    version: '0.0.1',
    private: true,
    type: 'module',
    main: 'index.mjs',
    dependencies: {
      ipx: '^3.0.0',
      sharp: '^0.34.0',
    },
    // @aws-sdk/client-s3 is provided by the Lambda Node 20 runtime;
    // we don't bundle it (saves ~16 MB unzipped, keeps the bundle
    // under Lambda's 50 MB limit).
  },
  null,
  2,
);
