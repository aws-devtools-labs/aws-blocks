// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { resolvePreviewProfile } from './hosting.js';

/** A CDK node with the given context values (real node — no casts needed). */
const nodeWith = (context: Record<string, string> = {}) =>
  new cdk.App({ context }).node;

test('preview off by default when no prop is passed', () => {
  const p = resolvePreviewProfile(undefined, nodeWith());
  assert.deepStrictEqual(p, {
    enabled: false,
    trimResources: false,
    fastTeardown: false,
    edgeToRegional: false,
    bypassCdn: false,
    skipIsr: false,
    skipImageOptimization: false,
  });
});

test('preview is STRICTLY opt-in — sandboxMode context does NOT auto-enable it', () => {
  // The invariant: an app that never sets `preview` deploys identically in a
  // sandbox and in production. sandboxMode must not flip any knob.
  const p = resolvePreviewProfile(undefined, nodeWith({ sandboxMode: 'true' }));
  assert.deepStrictEqual(p, {
    enabled: false,
    trimResources: false,
    fastTeardown: false,
    edgeToRegional: false,
    bypassCdn: false,
    skipIsr: false,
    skipImageOptimization: false,
  });
});

test('preview: true = maximum scale-down (no CDN, no cache, no image-opt)', () => {
  const p = resolvePreviewProfile(true, nodeWith());
  assert.strictEqual(p.enabled, true);
  assert.strictEqual(p.trimResources, true);
  assert.strictEqual(p.fastTeardown, true);
  assert.strictEqual(p.edgeToRegional, true);
  assert.strictEqual(p.bypassCdn, true);
  assert.strictEqual(p.skipIsr, true);
  assert.strictEqual(p.skipImageOptimization, true);
});

test('preview: false stays off even under sandbox context', () => {
  const p = resolvePreviewProfile(false, nodeWith({ sandboxMode: 'true' }));
  assert.strictEqual(p.enabled, false);
  assert.strictEqual(p.bypassCdn, false);
  assert.strictEqual(p.trimResources, false);
});

test('object form without enabled stays off (opt-in) — sandbox context ignored', () => {
  // A capability object with no `enabled` does NOT turn preview on.
  const p = resolvePreviewProfile({ cdn: true }, nodeWith({ sandboxMode: 'true' }));
  assert.strictEqual(p.enabled, false);
  assert.strictEqual(p.bypassCdn, false);
});

test('enabled:true + cdn:true keeps the CDN (CDN-fronted, production-like preview)', () => {
  const p = resolvePreviewProfile({ enabled: true, cdn: true }, nodeWith());
  assert.strictEqual(p.enabled, true);
  assert.strictEqual(p.bypassCdn, false, 'cdn kept → not bypassed');
  // other capabilities still scale down
  assert.strictEqual(p.skipIsr, true);
  assert.strictEqual(p.skipImageOptimization, true);
});

test('imageOptimization:true keeps image optimization; cdn still off', () => {
  const p = resolvePreviewProfile({ enabled: true, imageOptimization: true }, nodeWith());
  assert.strictEqual(p.skipImageOptimization, false, 'imageOptimization kept');
  assert.strictEqual(p.bypassCdn, true, 'cdn still off by default');
});

test('explicit enabled:true turns preview on in a non-sandbox deploy', () => {
  const p = resolvePreviewProfile({ enabled: true }, nodeWith());
  assert.strictEqual(p.enabled, true);
  assert.strictEqual(p.bypassCdn, true);
  assert.strictEqual(p.trimResources, true);
});

test('capabilities are inert when preview is off (enabled:false)', () => {
  // enabled:false with a capability set → still fully off.
  const p = resolvePreviewProfile(
    { enabled: false, cdn: true, imageOptimization: true },
    nodeWith({ sandboxMode: 'true' }),
  );
  assert.strictEqual(p.enabled, false);
  assert.strictEqual(p.bypassCdn, false);
  assert.strictEqual(p.skipImageOptimization, false);
});
