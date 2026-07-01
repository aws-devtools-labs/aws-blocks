// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getStackId, getSandboxId } from './stack-id.js';

describe('getStackId', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads stackId from .blocks/config.json', () => {
    tmpDir = join(tmpdir(), `stack-id-test-${Date.now()}`);
    mkdirSync(join(tmpDir, '.blocks'), { recursive: true });
    writeFileSync(join(tmpDir, '.blocks', 'config.json'), JSON.stringify({ stackId: 'test-abc123' }));
    assert.strictEqual(getStackId(tmpDir), 'test-abc123');
  });

  it('throws actionable error when config is missing', () => {
    tmpDir = join(tmpdir(), `stack-id-test-missing-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    assert.throws(() => getStackId(tmpDir), /\.blocks\/config\.json not found/);
  });

  it('throws actionable error when stackId key is missing', () => {
    tmpDir = join(tmpdir(), `stack-id-test-nokey-${Date.now()}`);
    mkdirSync(join(tmpDir, '.blocks'), { recursive: true });
    writeFileSync(join(tmpDir, '.blocks', 'config.json'), JSON.stringify({ other: 'value' }));
    assert.throws(() => getStackId(tmpDir), /\.blocks\/config\.json not found/);
  });
});

describe('getSandboxId', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates and persists a sandbox id', () => {
    tmpDir = join(tmpdir(), `sandbox-id-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const id = getSandboxId(tmpDir);
    assert.match(id, /^[a-z0-9]+-[a-f0-9]{6}$/);
    // Verify persisted
    const stored = readFileSync(join(tmpDir, '.blocks-sandbox', 'sandbox-id.txt'), 'utf-8').trim();
    assert.strictEqual(stored, id);
  });

  it('returns existing id on subsequent calls', () => {
    tmpDir = join(tmpdir(), `sandbox-id-test-idem-${Date.now()}`);
    mkdirSync(join(tmpDir, '.blocks-sandbox'), { recursive: true });
    writeFileSync(join(tmpDir, '.blocks-sandbox', 'sandbox-id.txt'), 'alice-abc123');
    assert.strictEqual(getSandboxId(tmpDir), 'alice-abc123');
  });
});
