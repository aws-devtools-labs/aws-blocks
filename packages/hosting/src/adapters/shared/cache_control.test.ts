// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateCacheControl } from './cache_control.js';

void describe('validateCacheControl', () => {
  void it('accepts "public, max-age=3600"', () => {
    assert.doesNotThrow(() =>
      validateCacheControl('public, max-age=3600', 'route /test'),
    );
  });

  void it('accepts "no-store"', () => {
    assert.doesNotThrow(() => validateCacheControl('no-store', 'route /test'));
  });

  void it('accepts "s-maxage=600, stale-while-revalidate=120"', () => {
    assert.doesNotThrow(() =>
      validateCacheControl(
        's-maxage=600, stale-while-revalidate=120',
        'route /test',
      ),
    );
  });

  void it('accepts "private, max-age=0, must-revalidate"', () => {
    assert.doesNotThrow(() =>
      validateCacheControl(
        'private, max-age=0, must-revalidate',
        'route /test',
      ),
    );
  });

  void it('throws on garbage', () => {
    assert.throws(
      () => validateCacheControl('not-a-directive', 'route /test'),
      {
        code: 'InvalidCacheControlError',
      },
    );
  });

  void it('throws on empty string', () => {
    assert.throws(() => validateCacheControl('', 'route /test'), {
      code: 'InvalidCacheControlError',
    });
  });

  void it('error message includes the bad value and context', () => {
    try {
      validateCacheControl('not-a-directive', 'route /foo (Nitro routeRules)');
      assert.fail('expected throw');
    } catch (err) {
      const e = err as Error & { code?: string };
      assert.match(e.message, /not-a-directive/);
      assert.match(e.message, /route \/foo \(Nitro routeRules\)/);
    }
  });

  void it('throws on numeric directive value typo', () => {
    // parse-cache-control accepts unknown directives gracefully but
    // rejects clearly malformed input. `max-age=abc` parses on some
    // permissive parsers but parse-cache-control rejects non-numeric
    // numeric directives.
    assert.throws(() => validateCacheControl('max-age=abc', 'route /test'), {
      code: 'InvalidCacheControlError',
    });
  });
});
