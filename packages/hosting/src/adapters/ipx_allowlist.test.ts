/**
 * Edge-case coverage for the IPX image-optimization Lambda allowlist
 * matchers. Driven by review feedback on PR #3220 — the
 * `startsWith` path-prefix bug + the absence of any tests for ~90
 * lines of security-critical URL parsing.
 *
 * What's covered:
 *   - Path-prefix segment boundary: `/images` MUST NOT match
 *     `/images-secret/anything` (the original bug).
 *   - Hostname spoofing via `@` userinfo
 *     (`https://allowed.com@evil.com/...`).
 *   - Wildcard hostname semantics: `*.example.com` matches
 *     subdomains but NOT the bare apex.
 *   - Protocol-relative URLs (`//allowed.com/...`) — should fail
 *     `new URL()` parse and reject.
 *   - Encoded-slash paths (`/images%2F../etc`) — `URL.pathname` does
 *     NOT decode, so the pattern still matches at the literal
 *     boundary, which is the intent.
 *   - Disallowed protocols (`file:`, `data:`, `javascript:`).
 *   - Patterns without trailing path separators
 *     (`/images` and `/images/` should behave identically).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isRemoteSourceAllowed,
  matchHostname,
  matchPathPrefix, looksLikeSvg } from './ipx_allowlist.js';

void describe('matchHostname', () => {
  void it('exact match', () => {
    assert.strictEqual(matchHostname('a.example.com', 'a.example.com'), true);
    assert.strictEqual(matchHostname('a.example.com', 'b.example.com'), false);
  });

  void it('wildcard prefix matches subdomains', () => {
    assert.strictEqual(matchHostname('a.example.com', '*.example.com'), true);
    assert.strictEqual(matchHostname('a.b.example.com', '*.example.com'), true);
  });

  void it('wildcard prefix does NOT match the bare apex', () => {
    // Mirrors Next.js semantics — `*.example.com` is "subdomains of",
    // not "example.com OR subdomains".
    assert.strictEqual(matchHostname('example.com', '*.example.com'), false);
  });

  void it('wildcard does not match unrelated hosts', () => {
    assert.strictEqual(matchHostname('attacker.com', '*.example.com'), false);
    // Lookalike variants must NOT match: a host that contains `example`
    // and `com` separated by something other than `.example.com` is not
    // a subdomain. Bypass attempts often hinge on string contains vs.
    // suffix-with-dot.
    assert.strictEqual(
      matchHostname('foo-example-com.attacker.com', '*.example.com'),
      false,
    );
  });

  void it('empty pattern matches nothing (default-deny)', () => {
    assert.strictEqual(matchHostname('example.com', ''), false);
  });
});

void describe('matchPathPrefix', () => {
  void it('exact match', () => {
    assert.strictEqual(matchPathPrefix('/images', '/images'), true);
  });

  void it('descendants match', () => {
    assert.strictEqual(matchPathPrefix('/images/foo.jpg', '/images'), true);
    assert.strictEqual(matchPathPrefix('/images/sub/x', '/images'), true);
  });

  void it('does NOT match across a segment boundary (the original bug)', () => {
    // The exact bypass Josh flagged: a `startsWith('/images')` check
    // would let this through. Anchor on the segment boundary instead.
    assert.strictEqual(
      matchPathPrefix('/images-secret/anything', '/images'),
      false,
    );
    assert.strictEqual(
      matchPathPrefix('/imagesXYZ/anything', '/images'),
      false,
    );
  });

  void it('treats trailing-slash and bare-prefix patterns identically', () => {
    assert.strictEqual(matchPathPrefix('/images/foo', '/images'), true);
    assert.strictEqual(matchPathPrefix('/images/foo', '/images/'), true);
    assert.strictEqual(matchPathPrefix('/images-secret', '/images/'), false);
  });

  void it('root pattern allows everything', () => {
    assert.strictEqual(matchPathPrefix('/anything', '/'), true);
    assert.strictEqual(matchPathPrefix('/', '/'), true);
  });

  void it('empty pattern is a no-op gate (allow)', () => {
    // Caller is expected to skip path matching when pattern is empty;
    // surfacing that here so the helper's behavior is explicit.
    assert.strictEqual(matchPathPrefix('/foo', ''), true);
  });
});

void describe('isRemoteSourceAllowed', () => {
  void it('allows host listed in allowedHostnames', () => {
    assert.strictEqual(
      isRemoteSourceAllowed(
        'https://cdn.example.com/img.png',
        [],
        ['cdn.example.com'],
      ),
      true,
    );
  });

  void it('allows host matched by remotePatterns wildcard', () => {
    assert.strictEqual(
      isRemoteSourceAllowed(
        'https://a.example.com/img.png',
        [{ hostname: '*.example.com' }],
        [],
      ),
      true,
    );
  });

  void it('rejects unlisted hosts (default-deny)', () => {
    assert.strictEqual(
      isRemoteSourceAllowed('https://attacker.com/img.png', [], []),
      false,
    );
  });

  void it('rejects userinfo-spoofed URLs', () => {
    // `URL.hostname` of `https://cdn.example.com@evil.com/x` is `evil.com`,
    // so the rest of the pipeline would already reject it. The explicit
    // userinfo guard avoids a misleading log line and codifies the
    // intent so a future contributor can't accidentally relax it.
    assert.strictEqual(
      isRemoteSourceAllowed(
        'https://cdn.example.com@evil.com/img.png',
        [],
        ['cdn.example.com'],
      ),
      false,
    );
    assert.strictEqual(
      isRemoteSourceAllowed(
        'https://cdn.example.com:hunter2@evil.com/img.png',
        [],
        ['cdn.example.com'],
      ),
      false,
    );
  });

  void it('rejects path-prefix bypass attempt (the original bug)', () => {
    // Pre-fix, `startsWith('/images')` would let `/images-secret`
    // pass when the pattern is `{ hostname: 'cdn.com', pathname: '/images/**' }`.
    assert.strictEqual(
      isRemoteSourceAllowed(
        'https://cdn.com/images-secret/leak.png',
        [{ hostname: 'cdn.com', pathname: '/images/**' }],
        [],
      ),
      false,
    );
    // Sanity: legitimate descendant still allowed.
    assert.strictEqual(
      isRemoteSourceAllowed(
        'https://cdn.com/images/ok.png',
        [{ hostname: 'cdn.com', pathname: '/images/**' }],
        [],
      ),
      true,
    );
  });

  void it('rejects non-http(s) protocols', () => {
    for (const url of [
      'file:///etc/passwd',
      'data:image/png;base64,AAA',
      'javascript:alert(1)',
      'ftp://allowed.example.com/x',
    ]) {
      assert.strictEqual(
        isRemoteSourceAllowed(
          url,
          [{ hostname: 'allowed.example.com' }],
          ['allowed.example.com'],
        ),
        false,
        `expected reject for ${url}`,
      );
    }
  });

  void it('rejects protocol-relative URLs (no scheme)', () => {
    // `new URL('//foo/bar')` requires a base; without one it throws.
    // The catch returns false — verifying that here.
    assert.strictEqual(
      isRemoteSourceAllowed(
        '//cdn.example.com/img.png',
        [],
        ['cdn.example.com'],
      ),
      false,
    );
  });

  void it('rejects malformed URLs', () => {
    assert.strictEqual(isRemoteSourceAllowed('not a url', [], []), false);
    assert.strictEqual(isRemoteSourceAllowed('', [], []), false);
  });

  void it('enforces protocol constraint on a matching pattern', () => {
    // Pattern says https-only; an http URL must be rejected even if
    // the hostname matches.
    assert.strictEqual(
      isRemoteSourceAllowed(
        'http://cdn.com/img.png',
        [{ hostname: 'cdn.com', protocol: 'https' }],
        [],
      ),
      false,
    );
    assert.strictEqual(
      isRemoteSourceAllowed(
        'https://cdn.com/img.png',
        [{ hostname: 'cdn.com', protocol: 'https' }],
        [],
      ),
      true,
    );
  });

  void it('enforces port constraint on a matching pattern', () => {
    assert.strictEqual(
      isRemoteSourceAllowed(
        'https://cdn.com:9000/img.png',
        [{ hostname: 'cdn.com', port: '8080' }],
        [],
      ),
      false,
    );
    assert.strictEqual(
      isRemoteSourceAllowed(
        'https://cdn.com:8080/img.png',
        [{ hostname: 'cdn.com', port: '8080' }],
        [],
      ),
      true,
    );
  });

  void it('treats `pathname: "/images"` (no trailing /**) the same as a literal prefix', () => {
    // Bare pathname patterns (no `/**`) should still anchor at the
    // segment boundary — the fix applies uniformly, not just to
    // wildcard-stripped patterns.
    assert.strictEqual(
      isRemoteSourceAllowed(
        'https://cdn.com/images-secret/x',
        [{ hostname: 'cdn.com', pathname: '/images' }],
        [],
      ),
      false,
    );
    assert.strictEqual(
      isRemoteSourceAllowed(
        'https://cdn.com/images/x',
        [{ hostname: 'cdn.com', pathname: '/images' }],
        [],
      ),
      true,
    );
  });

  void it('encoded-slash paths do not bypass segment boundary', () => {
    // `URL.pathname` keeps `%2F` literal; the matcher compares
    // literally, so an encoded slash does NOT cross a segment
    // boundary the way a real `/` would.
    assert.strictEqual(
      isRemoteSourceAllowed(
        'https://cdn.com/images%2F..%2Fetc/passwd',
        [{ hostname: 'cdn.com', pathname: '/images/**' }],
        [],
      ),
      false,
    );
  });
});

void describe('looksLikeSvg — SVG detected by content, not filename', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  void it('detects a bare <svg> document', () => {
    assert.strictEqual(looksLikeSvg(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), true);
  });

  void it('detects SVG behind an XML prolog, comment, DOCTYPE, BOM and whitespace', () => {
    const doc =
      '\uFEFF  \n<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg width="4"><rect/></svg>';
    assert.strictEqual(looksLikeSvg(enc(doc)), true);
  });

  void it('is case-insensitive and accepts an ArrayBuffer', () => {
    assert.strictEqual(looksLikeSvg(enc('<SVG/>').buffer as ArrayBuffer), true);
  });

  void it('does not flag raster images (binary magic numbers never start with "<")', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x3c, 0x73, 0x76, 0x67]); // PNG magic + "<svg"
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const gif = enc('GIF89a<svg>');
    assert.strictEqual(looksLikeSvg(png), false);
    assert.strictEqual(looksLikeSvg(jpeg), false);
    assert.strictEqual(looksLikeSvg(gif), false);
  });

  void it('does not flag non-SVG markup or an <svgfoo> lookalike', () => {
    assert.strictEqual(looksLikeSvg(enc('<html><body>hi</body></html>')), false);
    assert.strictEqual(looksLikeSvg(enc('<svgfoo></svgfoo>')), false);
  });

  void it('handles empty input', () => {
    assert.strictEqual(looksLikeSvg(undefined), false);
    assert.strictEqual(looksLikeSvg(null), false);
    assert.strictEqual(looksLikeSvg(new Uint8Array()), false);
  });
});
