// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatDeploySignal } from './deploy.js';

describe('formatDeploySignal — the machine-readable deploy completion line', () => {
  it('includes both the frontend url and the api when hosting is deployed', () => {
    const line = formatDeploySignal('https://api.example.com', 'https://app.cloudfront.net');
    assert.strictEqual(line, 'BLOCKS_DEPLOYED url=https://app.cloudfront.net api=https://api.example.com');
  });

  it('omits url= for a backend-only deploy (no hosting)', () => {
    const line = formatDeploySignal('https://api.example.com');
    assert.strictEqual(line, 'BLOCKS_DEPLOYED api=https://api.example.com');
  });

  it('starts with the stable BLOCKS_DEPLOYED prefix so a caller can grep one line', () => {
    assert.match(formatDeploySignal('https://api.example.com'), /^BLOCKS_DEPLOYED /);
    assert.match(
      formatDeploySignal('https://api.example.com', 'https://app.cloudfront.net'),
      /^BLOCKS_DEPLOYED /,
    );
  });
});
