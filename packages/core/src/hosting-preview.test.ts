// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { resolvePreviewProfile } from './hosting.js';

/** A CDK node with the given context values (real node — no casts needed). */
const nodeWith = (context: Record<string, string> = {}) =>
  new cdk.App({ context }).node;

test('preview off by default when no prop and no sandbox context', () => {
  const p = resolvePreviewProfile(undefined, nodeWith());
  assert.deepStrictEqual(p, {
    enabled: false,
    trimResources: false,
    fastTeardown: false,
    edgeToRegional: false,
    bypassCdn: false,
  });
});

test('preview auto-enables from sandboxMode context; bypassCdn stays opt-in', () => {
  const p = resolvePreviewProfile(undefined, nodeWith({ sandboxMode: 'true' }));
  assert.deepStrictEqual(p, {
    enabled: true,
    trimResources: true,
    fastTeardown: true,
    edgeToRegional: true,
    bypassCdn: false,
  });
});

test('preview: true enables every knob except bypassCdn', () => {
  const p = resolvePreviewProfile(true, nodeWith());
  assert.strictEqual(p.enabled, true);
  assert.strictEqual(p.trimResources, true);
  assert.strictEqual(p.fastTeardown, true);
  assert.strictEqual(p.edgeToRegional, true);
  assert.strictEqual(p.bypassCdn, false);
});

test('preview: false wins over sandbox context (production-safety default)', () => {
  const p = resolvePreviewProfile(false, nodeWith({ sandboxMode: 'true' }));
  assert.strictEqual(p.enabled, false);
  assert.strictEqual(p.trimResources, false);
  assert.strictEqual(p.edgeToRegional, false);
});

test('object form enables preview and overrides a single knob', () => {
  const p = resolvePreviewProfile(
    { edgeToRegional: false },
    nodeWith({ sandboxMode: 'true' }),
  );
  assert.strictEqual(p.enabled, true);
  assert.strictEqual(p.edgeToRegional, false, 'overridden knob is off');
  assert.strictEqual(p.trimResources, true, 'other knobs still default on');
  assert.strictEqual(p.fastTeardown, true);
});

test('bypassCdn can be opted into via the object form', () => {
  const p = resolvePreviewProfile(
    { enabled: true, bypassCdn: true },
    nodeWith(),
  );
  assert.strictEqual(p.enabled, true);
  assert.strictEqual(p.bypassCdn, true);
});

test('explicit enabled:true wins in a non-sandbox deploy', () => {
  const p = resolvePreviewProfile({ enabled: true }, nodeWith());
  assert.strictEqual(p.enabled, true);
  assert.strictEqual(p.trimResources, true);
});

test('knobs are forced off when the master switch is off', () => {
  // enabled:false with a knob set true → the knob is still off.
  const p = resolvePreviewProfile(
    { enabled: false, edgeToRegional: true },
    nodeWith({ sandboxMode: 'true' }),
  );
  assert.strictEqual(p.enabled, false);
  assert.strictEqual(p.edgeToRegional, false);
});
