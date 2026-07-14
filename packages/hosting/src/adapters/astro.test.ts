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
import { astroUsesSharpService, installSharpForAstroSsr } from './astro.js';

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
