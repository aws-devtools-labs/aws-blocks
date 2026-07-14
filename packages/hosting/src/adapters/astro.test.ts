// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Astro adapter internals — focused on the image-service / sharp-bundling
// logic added for issue #3 (`/_image` → `content-type: image/null` on the
// noop passthrough service).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  astroUsesSharpService,
  installSharpForAstroSsr,
  patchAstroRemoteImageRedirects,
  ASTRO_REDIRECT_PATCH_MARKER,
} from './astro.js';

void describe('astroUsesSharpService — decide whether to ship sharp (issue #3)', () => {
  it('returns true when no image.service is configured (Astro default = sharp)', () => {
    assert.equal(astroUsesSharpService({}), true);
    assert.equal(astroUsesSharpService({ image: {} }), true);
    assert.equal(astroUsesSharpService({ image: { domains: ['x.com'] } }), true);
  });

  it('returns true when the sharp service is explicitly configured', () => {
    assert.equal(
      astroUsesSharpService({
        image: { service: { entrypoint: 'astro/assets/services/sharp' } },
      }),
      true,
    );
  });

  it('returns FALSE for the noop passthrough service (opted out)', () => {
    assert.equal(
      astroUsesSharpService({
        image: { service: { entrypoint: 'astro/assets/services/noop' } },
      }),
      false,
    );
  });

  it('returns FALSE for a custom (non-sharp) service', () => {
    assert.equal(
      astroUsesSharpService({
        image: { service: { entrypoint: './my/custom-image-service' } },
      }),
      false,
    );
  });
});

void describe('installSharpForAstroSsr — idempotency + guard', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-sharp-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is a no-op when a linux-x64 sharp is already present (no npm install)', () => {
    // Pre-seed the marker package so the installer short-circuits BEFORE it
    // would shell out to npm — proves idempotency without network/npm.
    const marker = path.join(tmp, 'node_modules', '@img', 'sharp-linux-x64');
    fs.mkdirSync(marker, { recursive: true });
    fs.writeFileSync(path.join(marker, 'package.json'), '{}');
    // Must not throw and must not have created a package.json (short-circuit
    // returns before writing one).
    assert.doesNotThrow(() => installSharpForAstroSsr(tmp));
    assert.equal(
      fs.existsSync(path.join(tmp, 'package.json')),
      false,
      'short-circuit must happen before any package.json is written',
    );
  });
});

void describe('patchAstroRemoteImageRedirects — follow allowlisted redirects safely', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-redir-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // A minimal stand-in for the Astro assets chunk: imports isRemoteAllowed,
  // has the allowlist check + the manual-redirect fetch Astro core emits.
  const CHUNK = `import { i as isRemoteAllowed } from './remote.mjs';
async function loadRemoteImage(url, imageConfig) {
  const allowlistConfig = imageConfig ? { domains: imageConfig.domains ?? [], remotePatterns: imageConfig.remotePatterns ?? [] } : void 0;
  if (allowlistConfig && !isRemoteAllowed(url, allowlistConfig)) { throw new Error('not allowed'); }
  const response = await fetch(url, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) { throw new Error('3xx'); }
  return response;
}
export { loadRemoteImage };
`;

  const writeChunk = (contents: string): string => {
    const f = path.join(tmp, 'chunks', '_astro_assets_ABC.mjs');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, contents);
    return f;
  };

  void it('rewrites the manual-redirect fetch to the allowlist-aware helper + injects it', () => {
    const f = writeChunk(CHUNK);
    patchAstroRemoteImageRedirects(tmp);
    const out = fs.readFileSync(f, 'utf-8');
    assert.match(out, new RegExp(`async function ${ASTRO_REDIRECT_PATCH_MARKER}\\(`), 'helper injected');
    assert.match(out, new RegExp(`await ${ASTRO_REDIRECT_PATCH_MARKER}\\(url,`), 'fetch call rewritten');
    // The raw manual-redirect fetch call is gone.
    assert.doesNotMatch(out, /await fetch\(url, \{ redirect: "manual" \}\)/);
  });

  void it('is idempotent (marker guards a second run)', () => {
    const f = writeChunk(CHUNK);
    patchAstroRemoteImageRedirects(tmp);
    const once = fs.readFileSync(f, 'utf-8');
    patchAstroRemoteImageRedirects(tmp);
    const twice = fs.readFileSync(f, 'utf-8');
    assert.equal(once, twice);
  });

  void it('skips chunks that are not the remote-image chunk (no isRemoteAllowed)', () => {
    const f = writeChunk('export const x = await fetch(u, { redirect: "manual" });\n');
    patchAstroRemoteImageRedirects(tmp);
    const out = fs.readFileSync(f, 'utf-8');
    assert.doesNotMatch(out, new RegExp(ASTRO_REDIRECT_PATCH_MARKER));
  });

  void it('injected helper FOLLOWS an allowed redirect but STOPS at a disallowed one (SSRF-safe)', async () => {
    const f = writeChunk(CHUNK);
    patchAstroRemoteImageRedirects(tmp);
    const out = fs.readFileSync(f, 'utf-8');
    const m = out.match(
      new RegExp(`async function ${ASTRO_REDIRECT_PATCH_MARKER}\\([\\s\\S]*?\\n\\}`),
    );
    assert.ok(m, 'helper body present');

    // Harness: stub fetch to model picsum→fastly (allowed→allowed) and
    // picsum→evil (allowed→disallowed). isAllowed only permits picsum + fastly.
    const harness = `
      ${m[0]}
      const isAllowed = (u) => /(^|\\.)(picsum|fastly)\\.test$/.test(new URL(u).hostname);
      const fetchImpl = async (u) => {
        if (u === 'https://picsum.test/a') return { status: 302, headers: new Map([['location','https://fastly.test/final.jpg']]) };
        if (u === 'https://fastly.test/final.jpg') return { status: 200, headers: new Map() };
        if (u === 'https://picsum.test/evil') return { status: 302, headers: new Map([['location','https://evil.test/x']]) };
        return { status: 500, headers: new Map() };
      };
      globalThis.fetch = (u, opts) => fetchImpl(typeof u === 'string' ? u : u.toString());
      return (async () => {
        const okRes = await ${ASTRO_REDIRECT_PATCH_MARKER}('https://picsum.test/a', { domains: [] }, isAllowed);
        const badRes = await ${ASTRO_REDIRECT_PATCH_MARKER}('https://picsum.test/evil', { domains: [] }, isAllowed);
        return { okStatus: okRes.status, badStatus: badRes.status };
      })();
    `;
    // Map<...>.get(k) mirrors Headers.get(k); the helper uses .headers.get('location').
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(harness.replace('.headers.get("location")', '.headers.get("location")'));
    const { okStatus, badStatus } = (await fn()) as { okStatus: number; badStatus: number };
    assert.equal(okStatus, 200, 'allowed redirect (picsum→fastly) is followed to the 200');
    assert.equal(badStatus, 302, 'disallowed redirect (picsum→evil) is NOT followed; returns the 3xx for Astro to reject');
  });
});
