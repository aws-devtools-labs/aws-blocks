// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the `bb-data pull` prompts, driven through fake TTY streams: the
 * secret prompt must not echo, must accept a paste that ends in Enter, and both
 * prompts must reject (130 on Ctrl-C, 1 on EOF) instead of hanging or exiting 0.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { PassThrough } from 'node:stream';
import { readAnswer, readSecret, PromptAbortedError, type PromptIO } from './pull.js';

function fakeTty() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    rawModes: [] as boolean[],
    setRawMode(mode: boolean) { this.rawModes.push(mode); return this; },
  });
  const output = new PassThrough();
  let written = '';
  output.on('data', d => { written += d.toString(); });
  const io: PromptIO = { input, output };
  return { io, input, written: () => written };
}

const SECRET = 'postgresql://postgres.abcdefghijklmnopqrst:s3cretpw@127.0.0.1:41799/postgres';

describe('readSecret', () => {
  test('accepts a single-chunk paste ending in CR, without echoing it', async () => {
    const t = fakeTty();
    const answer = readSecret('Connection string: ', t.io);
    t.input.write(SECRET + '\r');
    assert.strictEqual(await answer, SECRET);
    assert.strictEqual(t.written(), 'Connection string: \n');
    assert.deepStrictEqual(t.input.rawModes, [true, false]);
  });

  test('accepts LF, drops bytes after Enter, and handles backspace/DEL', async () => {
    const t = fakeTty();
    const answer = readSecret('? ', t.io);
    t.input.write('abx\x7fc');
    t.input.write('d\b\be\nleftover');
    assert.strictEqual(await answer, 'abe');
    assert.ok(!t.written().includes('ab'));
  });

  test('Ctrl-C rejects with exit code 130 and restores raw mode', async () => {
    const t = fakeTty();
    const answer = readSecret('? ', t.io);
    t.input.write('sec\x03');
    await assert.rejects(answer, (e: PromptAbortedError) => e instanceof PromptAbortedError && e.exitCode === 130);
    assert.deepStrictEqual(t.input.rawModes, [true, false]);
  });

  test('Ctrl-D or EOF before any input rejects with a clear error', async () => {
    for (const eof of [true, false]) {
      const t = fakeTty();
      const answer = readSecret('? ', t.io);
      if (eof) t.input.end(); else t.input.write('\x04');
      await assert.rejects(answer, (e: PromptAbortedError) => e.exitCode === 1 && /stdin closed before an answer/.test(e.message));
      assert.deepStrictEqual(t.input.rawModes, [true, false]);
    }
  });
});

describe('readAnswer', () => {
  test('returns the trimmed line', async () => {
    const t = fakeTty();
    const answer = readAnswer('dev/prod? ', t.io);
    t.input.write(' prod \r');
    assert.strictEqual(await answer, 'prod');
  });

  test('Ctrl-C rejects with exit code 130', async () => {
    const t = fakeTty();
    const answer = readAnswer('dev/prod? ', t.io);
    t.input.write('\x03');
    await assert.rejects(answer, (e: PromptAbortedError) => e.exitCode === 130);
  });

  test('EOF before an answer rejects with a clear error', async () => {
    const t = fakeTty();
    const answer = readAnswer('dev/prod? ', t.io);
    t.input.end();
    await assert.rejects(answer, (e: PromptAbortedError) => e.exitCode === 1 && /stdin closed before an answer/.test(e.message));
  });
});
