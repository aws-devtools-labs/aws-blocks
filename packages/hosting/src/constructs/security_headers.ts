import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';
import {
  HeadersFrameOption,
  HeadersReferrerPolicy,
  ResponseCustomHeader,
  ResponseHeadersPolicy,
  ResponseSecurityHeadersBehavior,
} from 'aws-cdk-lib/aws-cloudfront';

// ---- Public types ----

/**
 * Props for the security headers factory function.
 */
export type SecurityHeadersProps = {
  /** Custom Content-Security-Policy header value. If not set, a restrictive default is used. */
  contentSecurityPolicy?: string;
};

// ---- Factory function ----

/**
 * Default Content-Security-Policy value.
 * Allows 'unsafe-inline' for script/style (needed for Next.js inline scripts),
 * wss: for AppSync subscriptions, and data: for images/fonts.
 * Does NOT include 'unsafe-eval'.
 */
const DEFAULT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https: wss:; media-src 'self'; object-src 'none'; frame-ancestors 'self'";

/**
 * Set of header names whose values are baked into the L3's strongly-typed
 * `securityHeadersBehavior`. If the user sets one of these via `headers()`
 * we have to either drop the L3 default for that header, or relax it to
 * non-override so the user's `customHeader` value wins.
 *
 * Why both modes: CloudFront's typed `securityHeadersBehavior` slots emit
 * the well-known header names regardless of `customHeadersBehavior` — if
 * we leave HSTS at `override: true` AND emit a custom HSTS, the typed
 * one wins. Setting `override: false` on the typed slot lets the
 * customHeader pass through.
 */
type SecurityHeaderName =
  | 'strict-transport-security'
  | 'x-content-type-options'
  | 'x-frame-options'
  | 'x-xss-protection'
  | 'referrer-policy'
  | 'content-security-policy';

const SECURITY_HEADER_NAMES: SecurityHeaderName[] = [
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'x-xss-protection',
  'referrer-policy',
  'content-security-policy',
];

/**
 * True if `headers` contains any security-relevant header (case-insensitive).
 * Used to decide whether silently dropping a header rule (e.g. when the
 * CloudFront behavior cap is hit) is safe (cosmetic header → warn) or must
 * fail the build (a lost CSP/HSTS looks like a successful deploy).
 */
export const containsSecurityHeader = (
  headers: Record<string, string>,
): boolean => {
  const names = new Set<string>(SECURITY_HEADER_NAMES);
  return Object.keys(headers).some((h) => names.has(h.toLowerCase()));
};

const isOverridden = (
  customHeaders: Record<string, string> | undefined,
  name: SecurityHeaderName,
): boolean => {
  if (!customHeaders) return false;
  // CloudFront customHeader names are case-insensitive but stored as-is.
  return Object.keys(customHeaders).some((k) => k.toLowerCase() === name);
};

// CloudFront's security-header slots accept these enumerated values.
const parseFrameOption = (raw: string): HeadersFrameOption | undefined => {
  switch (raw.toUpperCase().trim()) {
    case 'DENY':
      return HeadersFrameOption.DENY;
    case 'SAMEORIGIN':
      return HeadersFrameOption.SAMEORIGIN;
    default:
      return undefined;
  }
};

const parseReferrerPolicy = (
  raw: string,
): HeadersReferrerPolicy | undefined => {
  switch (raw.toLowerCase().trim()) {
    case 'no-referrer':
      return HeadersReferrerPolicy.NO_REFERRER;
    case 'no-referrer-when-downgrade':
      return HeadersReferrerPolicy.NO_REFERRER_WHEN_DOWNGRADE;
    case 'origin':
      return HeadersReferrerPolicy.ORIGIN;
    case 'origin-when-cross-origin':
      return HeadersReferrerPolicy.ORIGIN_WHEN_CROSS_ORIGIN;
    case 'same-origin':
      return HeadersReferrerPolicy.SAME_ORIGIN;
    case 'strict-origin':
      return HeadersReferrerPolicy.STRICT_ORIGIN;
    case 'strict-origin-when-cross-origin':
      return HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN;
    case 'unsafe-url':
      return HeadersReferrerPolicy.UNSAFE_URL;
    default:
      return undefined;
  }
};

// Parse `Strict-Transport-Security: max-age=N; includeSubDomains; preload`
// into the structured fields CloudFront expects. Returns null if the header
// is malformed (caller should fall back to defaults).
const parseHsts = (
  value: string,
): {
  maxAgeSec: number;
  includeSubdomains: boolean;
  preload: boolean;
} | null => {
  const parts = value.split(';').map((p) => p.trim().toLowerCase());
  const maxAgeMatch = parts.find((p) => p.startsWith('max-age='));
  if (!maxAgeMatch) return null;
  const maxAgeSec = parseInt(maxAgeMatch.slice('max-age='.length), 10);
  if (!Number.isFinite(maxAgeSec) || maxAgeSec < 0) return null;
  return {
    maxAgeSec,
    includeSubdomains: parts.includes('includesubdomains'),
    preload: parts.includes('preload'),
  };
};

const findCustomHeader = (
  customHeaders: Record<string, string> | undefined,
  name: SecurityHeaderName,
): string | undefined => {
  if (!customHeaders) return undefined;
  const key = Object.keys(customHeaders).find((k) => k.toLowerCase() === name);
  return key ? customHeaders[key] : undefined;
};

/**
 * Build the standard security-headers behavior block. Extracted so the
 * per-pattern policies (used by manifest.headers[]) can include the same
 * security headers without duplicating the values.
 *
 * When `customHeaders` is provided and overlaps with one of the typed
 * security-header slots, the user's value is parsed and injected into the
 * typed slot directly (override: true). CloudFront rejects security-named
 * headers from `customHeadersBehavior.customHeaders`, so we cannot pass
 * them through that path.
 */
const buildSecurityHeadersBehavior = (
  props?: SecurityHeadersProps,
  customHeaders?: Record<string, string>,
): ResponseSecurityHeadersBehavior => {
  // x-frame-options: parse user value if it's DENY/SAMEORIGIN; else default.
  const userFrame = findCustomHeader(customHeaders, 'x-frame-options');
  const frameOption: HeadersFrameOption =
    (userFrame ? parseFrameOption(userFrame) : undefined) ??
    HeadersFrameOption.SAMEORIGIN;

  // strict-transport-security: parse user value if well-formed.
  const userHsts = findCustomHeader(customHeaders, 'strict-transport-security');
  const parsedHsts = userHsts ? parseHsts(userHsts) : null;
  const hstsConfig = parsedHsts
    ? {
        accessControlMaxAge: Duration.seconds(parsedHsts.maxAgeSec),
        includeSubdomains: parsedHsts.includeSubdomains,
        preload: parsedHsts.preload,
        override: true,
      }
    : {
        accessControlMaxAge: Duration.days(730),
        includeSubdomains: true,
        preload: true,
        override: true,
      };

  // referrer-policy: parse user value if it matches a known policy.
  const userReferrer = findCustomHeader(customHeaders, 'referrer-policy');
  const referrerPolicy: HeadersReferrerPolicy =
    (userReferrer ? parseReferrerPolicy(userReferrer) : undefined) ??
    HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN;

  // content-security-policy: user value beats the L3 default if present.
  const userCsp = findCustomHeader(customHeaders, 'content-security-policy');

  return {
    strictTransportSecurity: hstsConfig,
    contentTypeOptions: {
      override: !isOverridden(customHeaders, 'x-content-type-options'),
    },
    frameOptions: {
      frameOption,
      override: true,
    },
    xssProtection: {
      protection: true,
      modeBlock: true,
      override: !isOverridden(customHeaders, 'x-xss-protection'),
    },
    referrerPolicy: {
      referrerPolicy,
      override: true,
    },
    // CSP override is conditional on the user having opted in. Forcing
    // override:true on the default CSP would silently strip per-request
    // nonces emitted by SSR frameworks (e.g. Next.js Server Components),
    // breaking inline scripts. Only override when the user explicitly
    // supplied a CSP — either via headers() or via the contentSecurityPolicy
    // prop — and let the origin's CSP win otherwise.
    contentSecurityPolicy: {
      contentSecurityPolicy:
        userCsp ?? props?.contentSecurityPolicy ?? DEFAULT_CSP,
      override:
        userCsp !== undefined || props?.contentSecurityPolicy !== undefined,
    },
  };
};

/**
 * Create a CloudFront ResponseHeadersPolicy with security headers.
 *
 * Includes HSTS (2 years, preload), X-Content-Type-Options, X-Frame-Options,
 * XSS-Protection, Referrer-Policy, and a Content-Security-Policy.
 */
export const createSecurityHeadersPolicy = (
  scope: Construct,
  id: string,
  props?: SecurityHeadersProps,
): ResponseHeadersPolicy => {
  return new ResponseHeadersPolicy(scope, id, {
    securityHeadersBehavior: buildSecurityHeadersBehavior(props),
  });
};

/**
 * Create a per-pattern ResponseHeadersPolicy that bundles the security
 * headers with a set of custom headers (one entry per pattern in
 * `manifest.headers[]`).
 *
 * Why a separate policy per pattern: CloudFront associates exactly one
 * ResponseHeadersPolicy with each cache behavior. We can't selectively
 * add headers — each behavior needs its own combined policy.
 */
export const createCustomHeadersPolicy = (
  scope: Construct,
  id: string,
  customHeaders: Record<string, string>,
  props?: SecurityHeadersProps,
): ResponseHeadersPolicy => {
  // CloudFront rejects security-named headers from the customHeaders
  // array (Status 400 — must be set via securityHeadersBehavior).
  // Filter them here; their values are folded into the typed slots
  // by buildSecurityHeadersBehavior(customHeaders).
  const items: ResponseCustomHeader[] = Object.entries(customHeaders)
    .filter(
      ([header]) =>
        !SECURITY_HEADER_NAMES.includes(
          header.toLowerCase() as SecurityHeaderName,
        ),
    )
    .map(([header, value]) => ({
      header,
      value,
      // Override so the manifest's value wins over the origin's. Custom
      // headers are explicit user intent; surprising precedence rules
      // (origin-wins) would be very confusing.
      override: true,
    }));
  return new ResponseHeadersPolicy(scope, id, {
    securityHeadersBehavior: buildSecurityHeadersBehavior(props, customHeaders),
    customHeadersBehavior: { customHeaders: items },
  });
};
export { SECURITY_HEADER_NAMES };
