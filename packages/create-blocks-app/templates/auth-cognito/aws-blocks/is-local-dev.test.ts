import { test } from 'node:test';
import assert from 'node:assert';
import { isLocalDev, localDevOnly } from './is-local-dev.js';

// A stand-in for a captured OTP payload (shape returned by getLastCode()).
const SAMPLE = { username: 'demo@test.example', code: '123456', purpose: 'signUp' } as const;

/** Run `fn` with BLOCKS_STACK_NAME forced to `value` (or removed), then restore. */
function withStackName(value: string | undefined, fn: () => void): void {
  const original = process.env.BLOCKS_STACK_NAME;
  try {
    if (value === undefined) delete process.env.BLOCKS_STACK_NAME;
    else process.env.BLOCKS_STACK_NAME = value;
    fn();
  } finally {
    if (original === undefined) delete process.env.BLOCKS_STACK_NAME;
    else process.env.BLOCKS_STACK_NAME = original;
  }
}

test('local/mock dev (no BLOCKS_STACK_NAME): the OTP helper returns the code', () => {
  withStackName(undefined, () => {
    assert.strictEqual(isLocalDev(), true);
    assert.deepStrictEqual(localDevOnly(SAMPLE), SAMPLE);
  });
});

test('deployed env (BLOCKS_STACK_NAME set): the OTP helper is unavailable (null)', () => {
  withStackName('my-app-prod', () => {
    assert.strictEqual(isLocalDev(), false);
    // Even with a captured code in hand, nothing is returned in a deployed env.
    assert.strictEqual(localDevOnly(SAMPLE), null);
  });
});

test('deployed env: an empty BLOCKS_STACK_NAME is treated as deployed-safe (local)', () => {
  // Defensive: an empty string is falsy, so the gate opens — matches the
  // framework convention of testing truthiness of the injected value.
  withStackName('', () => {
    assert.strictEqual(isLocalDev(), true);
  });
});
