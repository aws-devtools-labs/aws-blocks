// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deleteDrainSet } from './kv_keys_handler.js';

// Regression for the Delete-path drain bug: CloudFormation does not send
// OldResourceProperties on Delete, so the keys to drain must come from
// ResourceProperties.Entries. A previous version read OldResourceProperties →
// always empty → nothing drained → orphaned KVS keys.
describe('kv_keys_handler — deleteDrainSet', () => {
  it('drains the keys from ResourceProperties.Entries (Delete has no OldResourceProperties)', () => {
    const entries = { meta: '{"b":"x"}', r0: '[]', d0: '[]' };
    const event = {
      RequestType: 'Delete' as const,
      ResourceProperties: { KvsArn: 'arn:kvs', Entries: JSON.stringify(entries) },
      // CloudFormation does NOT include this on Delete — present here as undefined
      OldResourceProperties: undefined,
    };
    assert.deepEqual(deleteDrainSet(event), entries);
  });

  it('returns {} when there are no entries', () => {
    const event = {
      RequestType: 'Delete' as const,
      ResourceProperties: { KvsArn: 'arn:kvs', Entries: '' },
    };
    assert.deepEqual(deleteDrainSet(event), {});
  });

  it('does NOT depend on OldResourceProperties (would be the bug)', () => {
    // Even if OldResourceProperties were somehow set, the drain set is driven
    // by ResourceProperties — the only field CFN populates on Delete.
    const real = { meta: '{}', h0: '[]' };
    const event = {
      RequestType: 'Delete' as const,
      ResourceProperties: { KvsArn: 'arn:kvs', Entries: JSON.stringify(real) },
      OldResourceProperties: { Entries: '{}' },
    };
    assert.deepEqual(deleteDrainSet(event), real);
  });
});
