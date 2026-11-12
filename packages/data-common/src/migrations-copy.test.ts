// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyMigrationsCommand } from './migrations-copy.js';

test('copyMigrationsCommand copies a path with ", $, a backtick, a quote and a space literally', { skip: process.platform === 'win32' && 'sh' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'migrations-copy-'));
  try {
    const from = join(root, `my "app" $HOME \`x\` it's`, 'migrations');
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, '001.sql'), 'select 1;');
    const to = join(root, 'out $PWD', 'migrations');
    mkdirSync(join(root, 'out $PWD'));
    execFileSync('sh', ['-c', copyMigrationsCommand(from, to)], { env: { ...process.env, HOME: '/nonexistent' } });
    assert.ok(existsSync(join(to, '001.sql')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
