// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ChildProcess } from 'node:child_process';
import { runCapture, spawnCommand, spawnShellCommand } from './run-command.js';

/** Collect a child's stdout until it exits. */
function stdoutOf(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.once('error', reject);
    child.once('close', () => resolve(out));
  });
}

describe('runCapture', () => {
  it('returns the command\'s stdout', () => {
    assert.strictEqual(runCapture(process.execPath, ['-e', 'process.stdout.write("a\\nb")']), 'a\nb');
  });

  it('throws on a non-zero exit with the captured stderr on error.stderr', () => {
    assert.throws(
      () => runCapture(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(3)']),
      (e: Error & { stderr?: string }) => {
        assert.match(e.message, /exited with code 3/);
        assert.strictEqual(e.stderr, 'boom');
        return true;
      },
    );
  });

  it('throws the spawn error for a missing command', () => {
    assert.throws(() => runCapture('definitely-not-a-real-command-xyz', []), /ENOENT/);
  });
});

describe('spawnCommand', () => {
  it('passes each arg to the command verbatim, with no shell', async () => {
    const arg = 'a b; echo two $HOME "q" %PATH%';
    const child = spawnCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', arg], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    assert.strictEqual(await stdoutOf(child), arg);
  });
});

describe('spawnShellCommand', () => {
  it('runs the whole command line through the shell', async () => {
    const child = spawnShellCommand('echo one&& echo two', { stdio: ['ignore', 'pipe', 'inherit'] });
    const lines = (await stdoutOf(child)).split(/\r?\n/).filter(Boolean).map((l) => l.trim());
    assert.deepStrictEqual(lines, ['one', 'two']);
  });
});
