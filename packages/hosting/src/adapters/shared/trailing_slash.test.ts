// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { emitTrailingSlashRedirects } from './trailing_slash.js';

void describe('emitTrailingSlashRedirects', () => {
  void it('returns [] when mode is "ignore"', () => {
    assert.deepStrictEqual(
      emitTrailingSlashRedirects(['/foo', '/bar/'], 'ignore'),
      [],
    );
  });

  void it('returns [] when paths is empty', () => {
    assert.deepStrictEqual(emitTrailingSlashRedirects([], 'always'), []);
    assert.deepStrictEqual(emitTrailingSlashRedirects([], 'never'), []);
  });

  void it('"always" emits 308 redirects from no-slash to slash', () => {
    assert.deepStrictEqual(
      emitTrailingSlashRedirects(['/about', '/blog'], 'always'),
      [
        { source: '/about', destination: '/about/', statusCode: 308 },
        { source: '/blog', destination: '/blog/', statusCode: 308 },
      ],
    );
  });

  void it('"always" skips paths that already have a trailing slash', () => {
    assert.deepStrictEqual(
      emitTrailingSlashRedirects(['/about/', '/blog'], 'always'),
      [{ source: '/blog', destination: '/blog/', statusCode: 308 }],
    );
  });

  void it('"never" emits 308 redirects from slash to no-slash', () => {
    assert.deepStrictEqual(
      emitTrailingSlashRedirects(['/about/', '/blog/'], 'never'),
      [
        { source: '/about/', destination: '/about', statusCode: 308 },
        { source: '/blog/', destination: '/blog', statusCode: 308 },
      ],
    );
  });

  void it('"never" skips paths without a trailing slash', () => {
    assert.deepStrictEqual(
      emitTrailingSlashRedirects(['/about', '/blog/'], 'never'),
      [{ source: '/blog/', destination: '/blog', statusCode: 308 }],
    );
  });

  void it('skips the root path "/"', () => {
    assert.deepStrictEqual(emitTrailingSlashRedirects(['/'], 'always'), []);
    assert.deepStrictEqual(emitTrailingSlashRedirects(['/'], 'never'), []);
  });

  void it('skips wildcard patterns', () => {
    assert.deepStrictEqual(
      emitTrailingSlashRedirects(['/blog/*', '/api/*', '*'], 'always'),
      [],
    );
  });

  void it('dedupes repeated paths', () => {
    assert.deepStrictEqual(
      emitTrailingSlashRedirects(['/about', '/about', '/about'], 'always'),
      [{ source: '/about', destination: '/about/', statusCode: 308 }],
    );
  });

  void it('prepends leading slash to bare paths', () => {
    assert.deepStrictEqual(
      emitTrailingSlashRedirects(['about', 'blog'], 'always'),
      [
        { source: '/about', destination: '/about/', statusCode: 308 },
        { source: '/blog', destination: '/blog/', statusCode: 308 },
      ],
    );
  });
});
