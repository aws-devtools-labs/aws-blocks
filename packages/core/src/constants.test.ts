// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CLIENT_USER_AGENT_HEADER } from './constants.js';

describe('CLIENT_USER_AGENT_HEADER', () => {
  it('is the lowercase custom header name', () => {
    assert.strictEqual(CLIENT_USER_AGENT_HEADER, 'x-blocks-user-agent');
  });
});
