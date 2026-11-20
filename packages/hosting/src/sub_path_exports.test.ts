// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

void describe('sub-path exports', () => {
  void it('resolves ./constructs', () => {
    assert.ok(require.resolve('@aws-cdk-blocks/hosting/constructs'));
  });

  void it('resolves ./adapters', () => {
    assert.ok(require.resolve('@aws-cdk-blocks/hosting/adapters'));
  });

  void it('resolves ./error', () => {
    assert.ok(require.resolve('@aws-cdk-blocks/hosting/error'));
  });

  void it('resolves ./scripts', () => {
    assert.ok(require.resolve('@aws-cdk-blocks/hosting/scripts'));
  });

  void it('resolves main entry (the CDK-free value API)', () => {
    assert.ok(require.resolve('@aws-cdk-blocks/hosting'));
  });
});
