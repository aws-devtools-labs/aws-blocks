// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
// Imported through `./deploy.js` ON PURPOSE: the helper is defined in
// deploy-stream.ts (and unit-tested there over its behaviour), but deploy.ts
// re-exports it as part of its public surface for external callers. This file
// guards that re-export — if the re-export is ever dropped, this import fails
// to resolve and the suite goes red. Its behavioural cases below double as a
// smoke test that the re-exported binding is the real function.
import { formatDeploySignal, parseWaitLiveArgs, DEFAULT_WAIT_LIVE_TIMEOUT_SEC } from './deploy.js';

describe('formatDeploySignal — the machine-readable deploy completion line', () => {
  it('is re-exported by deploy.ts (the public surface external callers import)', () => {
    assert.strictEqual(typeof formatDeploySignal, 'function');
  });

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

describe('parseWaitLiveArgs — the --wait-live flag family', () => {
  it('defaults to not waiting when no flag is present', () => {
    const r = parseWaitLiveArgs(['--some-other-flag']);
    assert.strictEqual(r.waitLive, false);
    assert.strictEqual(r.waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
  });

  it('opts in on --wait-live with the default timeout', () => {
    const r = parseWaitLiveArgs(['--wait-live']);
    assert.strictEqual(r.waitLive, true);
    assert.strictEqual(r.waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
  });

  it('honors an explicit --wait-live-timeout=<seconds>', () => {
    const r = parseWaitLiveArgs(['--wait-live', '--wait-live-timeout=90']);
    assert.strictEqual(r.waitLive, true);
    assert.strictEqual(r.waitLiveTimeoutSec, 90);
  });

  it('floors a fractional timeout', () => {
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=12.9']).waitLiveTimeoutSec, 12);
  });

  it('falls back to the default on a non-numeric or out-of-range timeout (never fails the deploy)', () => {
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=abc']).waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=0']).waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=-5']).waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=99999']).waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
  });
});
