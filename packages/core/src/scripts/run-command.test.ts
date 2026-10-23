// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { runCapture } from './run-command.js';

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

  it('throws when the command is killed by a signal', { skip: process.platform === 'win32' }, () => {
    assert.throws(() => runCapture(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']), /terminated by signal SIGTERM/);
  });
});
