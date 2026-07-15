/**
 * Cross-adapter version-pin gate (X.1).
 *
 * Each framework adapter exports a `VERIFIED_*_RANGE` constant that
 * documents which upstream version range we've actually exercised.
 * This test enforces three properties:
 *
 *   1. The exported range is parseable by semver. A typo
 *      (`>=3.10` without the patch component, etc.) would silently
 *      pass at build time but cause `semver.satisfies` to throw at
 *      runtime — fail loud at test time instead.
 *
 *   2. The range expresses an upper bound. A range like `>=3.10.0`
 *      with no upper limit defeats the entire purpose of pinning —
 *      a future major release would silently be considered
 *      "verified". The check looks for a `<`/`<=` token to confirm
 *      the upper bound is explicit.
 *
 *   3. Range strings are non-empty and exported.
 *
 * The guarantee this provides: a contributor who wants to ship a new
 * adapter version MUST update the constant in the adapter (the
 * existing `warnIfOpenNextOutOfRange` / equivalents will warn at
 * build time too). CI fails if any adapter ships with an open-ended
 * range.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import semver from 'semver';
import { VERIFIED_OPENNEXT_RANGE } from './nextjs.js';
import { VERIFIED_NITRO_RANGE } from './nitro.js';
import { VERIFIED_ASTRO_RANGE } from './astro.js';
import { VERIFIED_SVELTEKIT_RANGE } from './sveltekit.js';

const adapters = [
  { name: 'next/opennext', range: VERIFIED_OPENNEXT_RANGE },
  { name: 'nitro', range: VERIFIED_NITRO_RANGE },
  { name: 'astro', range: VERIFIED_ASTRO_RANGE },
  { name: 'sveltekit', range: VERIFIED_SVELTEKIT_RANGE },
];

void describe('adapter version pins (X.1)', () => {
  for (const { name, range } of adapters) {
    void describe(name, () => {
      void it('exports a parseable semver range', () => {
        assert.ok(
          typeof range === 'string' && range.length > 0,
          `${name} range must be a non-empty string`,
        );
        // semver accepts complex range strings; treat any non-null
        // result from validRange() as parseable.
        assert.notStrictEqual(
          semver.validRange(range),
          null,
          `${name} range "${range}" is not a valid semver range`,
        );
      });

      void it('expresses an upper bound', () => {
        // A range without an upper bound like `>=1.0.0` would silently
        // be considered "verified" against any future major. Require
        // an explicit `<` or `<=` token.
        assert.ok(
          /(<=|<)/.test(range),
          `${name} range "${range}" must include an upper bound (<= or <)`,
        );
      });
    });
  }

  void it('catches a hypothetical contributor mistake', () => {
    // Sanity check: confirm the validators we rely on actually catch
    // the failure modes above. If this test ever passes when it
    // shouldn't, the validators above are broken.
    assert.strictEqual(semver.validRange('not-a-range'), null);
    assert.strictEqual(/(<=|<)/.test('>=1.0.0'), false);
  });
});
