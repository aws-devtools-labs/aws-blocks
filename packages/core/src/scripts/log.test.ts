// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { BLOCKS_LOG_LEVEL_ENV, isCuratedLevel, log, resolveLogLevel } from './log.js';
import { devRequestLogging } from './dev-server.js';

const saved = process.env[BLOCKS_LOG_LEVEL_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[BLOCKS_LOG_LEVEL_ENV];
  else process.env[BLOCKS_LOG_LEVEL_ENV] = saved;
  mock.restoreAll();
});

/** Run `fn` at `level` (`undefined` = unset) and return every console call it made. */
function capture(level: string | undefined, fn: () => void): Array<[string, unknown[]]> {
  if (level === undefined) delete process.env[BLOCKS_LOG_LEVEL_ENV];
  else process.env[BLOCKS_LOG_LEVEL_ENV] = level;
  const calls: Array<[string, unknown[]]> = [];
  for (const method of ['log', 'warn', 'error'] as const) {
    mock.method(console, method, (...args: unknown[]) => {
      calls.push([method, args]);
    });
  }
  fn();
  mock.restoreAll();
  return calls;
}

describe('resolveLogLevel', () => {
  it('is legacy when unset, empty or unrecognised, so a typo never hides output', () => {
    assert.strictEqual(resolveLogLevel({}), 'legacy');
    assert.strictEqual(resolveLogLevel({ BLOCKS_LOG_LEVEL: '' }), 'legacy');
    assert.strictEqual(resolveLogLevel({ BLOCKS_LOG_LEVEL: 'silent' }), 'legacy');
    assert.strictEqual(resolveLogLevel({ BLOCKS_LOG_LEVEL: '1' }), 'legacy');
    assert.strictEqual(resolveLogLevel({ BLOCKS_LOG_LEVEL: 'constructor' }), 'legacy');
  });

  it('accepts the four levels case-insensitively', () => {
    assert.strictEqual(resolveLogLevel({ BLOCKS_LOG_LEVEL: 'quiet' }), 'quiet');
    assert.strictEqual(resolveLogLevel({ BLOCKS_LOG_LEVEL: ' Normal ' }), 'normal');
    assert.strictEqual(resolveLogLevel({ BLOCKS_LOG_LEVEL: 'VERBOSE' }), 'verbose');
    assert.strictEqual(resolveLogLevel({ BLOCKS_LOG_LEVEL: 'debug' }), 'debug');
  });

  it('reads the environment on every call', () => {
    process.env[BLOCKS_LOG_LEVEL_ENV] = 'quiet';
    assert.strictEqual(resolveLogLevel(), 'quiet');
    process.env[BLOCKS_LOG_LEVEL_ENV] = 'verbose';
    assert.strictEqual(resolveLogLevel(), 'verbose');
  });

  it('curates child output only at quiet and normal', () => {
    assert.deepStrictEqual(
      (['legacy', 'quiet', 'normal', 'verbose', 'debug'] as const).filter(isCuratedLevel),
      ['quiet', 'normal'],
    );
  });
});

describe('log', () => {
  const emitAll = (): void => {
    log.progress('🚀 Deploying to AWS...');
    log.detail('   (This may take a few minutes on first deploy)');
    log.warn('⚠️  could not empty bucket', 42);
    log.debugError(new Error('boom'));
  };

  it('with BLOCKS_LOG_LEVEL unset, makes exactly the console calls it replaced', () => {
    assert.deepStrictEqual(capture(undefined, emitAll), [
      ['log', ['🚀 Deploying to AWS...']],
      ['log', ['   (This may take a few minutes on first deploy)']],
      ['warn', ['⚠️  could not empty bucket', 42]],
    ]);
  });

  it('prints nothing but errors at quiet', () => {
    assert.deepStrictEqual(capture('quiet', emitAll), []);
  });

  it('drops detail at normal', () => {
    assert.deepStrictEqual(capture('normal', emitAll), [
      ['log', ['🚀 Deploying to AWS...']],
      ['warn', ['⚠️  could not empty bucket', 42]],
    ]);
  });

  it('matches legacy at verbose', () => {
    assert.deepStrictEqual(capture('verbose', emitAll), capture(undefined, emitAll));
  });

  it('adds the stack trace at debug', () => {
    const calls = capture('debug', emitAll);
    assert.deepStrictEqual(calls.slice(0, 3), capture(undefined, emitAll));
    assert.strictEqual(calls.length, 4);
    assert.strictEqual(calls[3][0], 'error');
    assert.match(String(calls[3][1][0]), /^Error: boom\n\s+at /);
  });
});

describe('devRequestLogging', () => {
  it('keeps today\'s behaviour when BLOCKS_LOG_LEVEL is unset', () => {
    assert.deepStrictEqual(devRequestLogging({}), { traffic: true, errors: true, stacks: true });
    assert.deepStrictEqual(devRequestLogging({ BLOCKS_DEV_QUIET: '1' }), { traffic: false, errors: false, stacks: false });
  });

  it('hides per-call traffic at quiet and normal but keeps errors', () => {
    for (const level of ['quiet', 'normal']) {
      assert.deepStrictEqual(devRequestLogging({ BLOCKS_LOG_LEVEL: level }), { traffic: false, errors: true, stacks: false });
    }
  });

  it('shows traffic at verbose and stacks only at debug', () => {
    assert.deepStrictEqual(devRequestLogging({ BLOCKS_LOG_LEVEL: 'verbose' }), { traffic: true, errors: true, stacks: false });
    assert.deepStrictEqual(devRequestLogging({ BLOCKS_LOG_LEVEL: 'debug' }), { traffic: true, errors: true, stacks: true });
  });

  it('lets BLOCKS_DEV_QUIET silence every level', () => {
    assert.deepStrictEqual(devRequestLogging({ BLOCKS_DEV_QUIET: '1', BLOCKS_LOG_LEVEL: 'debug' }), {
      traffic: false,
      errors: false,
      stacks: false,
    });
  });
});
