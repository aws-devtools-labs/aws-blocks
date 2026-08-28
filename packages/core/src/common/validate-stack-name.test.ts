// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { assertValidStackName } from './index.js';

describe('assertValidStackName', () => {
  for (const name of ['my-app', 'MyApp123', 'a', 'app-1-2-3', 'A'.repeat(128)]) {
    it(`accepts the valid name "${name.slice(0, 12)}${name.length > 12 ? '…' : ''}"`, () => {
      assert.doesNotThrow(() => assertValidStackName(name));
    });
  }

  for (const name of ['my_app', 'my app', '1app', '-app', 'app!', 'a'.repeat(129)]) {
    it(`rejects the invalid name "${name.slice(0, 12)}${name.length > 12 ? '…' : ''}"`, () => {
      assert.throws(
        () => assertValidStackName(name),
        (e: unknown) => {
          assert.ok(e instanceof Error);
          assert.strictEqual(e.name, 'InvalidStackNameError');
          assert.match(e.message, new RegExp(`"${name.slice(0, 5)}`)); // names the offending value
          assert.match(e.message, /Rename the stack — for example "/); // offers a suggestion
          return true;
        },
      );
    });
  }

  it('suggests a sanitized, letter-leading name', () => {
    assert.throws(
      () => assertValidStackName('123 my_app!'),
      (e: unknown) => {
        // digits/space/underscore/punctuation collapse to hyphens; leading non-letters stripped.
        assert.match((e as Error).message, /for example "my-app"/);
        return true;
      },
    );
  });
});
