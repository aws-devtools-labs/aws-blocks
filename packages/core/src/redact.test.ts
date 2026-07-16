// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { redactForLogging, redactToJson, REDACTED } from './redact.js';

describe('redactForLogging', () => {
  it('redacts a top-level password field', () => {
    const out = redactForLogging({ username: 'alice', password: 'hunter2' });
    assert.deepEqual(out, { username: 'alice', password: REDACTED });
  });

  it('redacts every sensitive credential/token field name', () => {
    const out = redactForLogging({
      password: 'p',
      newPassword: 'np',
      session: 's',
      accessToken: 'at',
      refreshToken: 'rt',
      idToken: 'it',
      sharedSecret: 'ss',
      clientSecret: 'cs',
      apiKey: 'ak',
      authorization: 'Bearer x',
      code: '123456',
      credentials: 'c',
    });
    for (const v of Object.values(out as Record<string, unknown>)) {
      assert.equal(v, REDACTED);
    }
  });

  it('matches field names case-insensitively', () => {
    const out = redactForLogging({ PassWord: 'x', SESSION: 'y' }) as Record<string, unknown>;
    assert.equal(out.PassWord, REDACTED);
    assert.equal(out.SESSION, REDACTED);
  });

  it('leaves non-sensitive fields untouched', () => {
    const input = { username: 'bob', email: 'b@example.com', count: 3, ok: true };
    assert.deepEqual(redactForLogging(input), input);
  });

  it('walks nested objects', () => {
    const out = redactForLogging({
      action: 'confirmSignIn',
      payload: { session: 'tok', code: '999' },
    });
    assert.deepEqual(out, {
      action: 'confirmSignIn',
      payload: { session: REDACTED, code: REDACTED },
    });
  });

  it('walks arrays (e.g. positional RPC args)', () => {
    const out = redactForLogging([
      { action: 'signIn', username: 'a', password: 'secret' },
      { action: 'confirmSignIn', session: 'tok', code: '111' },
    ]);
    assert.deepEqual(out, [
      { action: 'signIn', username: 'a', password: REDACTED },
      { action: 'confirmSignIn', session: REDACTED, code: REDACTED },
    ]);
  });

  it('preserves null/undefined sensitive fields without masking', () => {
    const out = redactForLogging({ password: null, session: undefined }) as Record<string, unknown>;
    assert.equal(out.password, null);
    assert.equal(out.session, undefined);
  });

  it('returns primitives unchanged', () => {
    assert.equal(redactForLogging('just a string'), 'just a string');
    assert.equal(redactForLogging(42), 42);
    assert.equal(redactForLogging(null), null);
  });

  it('does not mutate the input object', () => {
    const input = { password: 'keep-me', username: 'alice' };
    redactForLogging(input);
    assert.equal(input.password, 'keep-me');
  });

  // Regression: the auth state machine ships secrets as form-field
  // descriptors `{ name: 'session', defaultValue: '<token>' }`. The secret
  // sits under `defaultValue`, NOT under a key literally named `session`, so
  // plain key-name redaction walks past it. These guard the descriptor branch.
  it('redacts defaultValue of a sensitive AuthField descriptor', () => {
    const out = redactForLogging({
      name: 'session',
      label: 'Session',
      type: 'hidden',
      defaultValue: 'COGNITO_SESSION_TOKEN',
    }) as Record<string, unknown>;
    assert.equal(out.name, 'session');
    assert.equal(out.defaultValue, REDACTED);
  });

  it('redacts session + sharedSecret in a full confirmingSignIn AuthState', () => {
    const authState = {
      state: 'confirmingSignIn',
      actions: [{
        name: 'confirmSignIn',
        label: 'Set Up Authenticator',
        fields: [
          { name: 'session', label: 'Session', type: 'hidden', required: true, defaultValue: 'SESSION_TOKEN_abc' },
          { name: 'sharedSecret', label: 'Shared Secret', type: 'hidden', required: true, defaultValue: 'JBSWY3DPEHPK3PXP' },
          { name: 'code', label: 'Code', type: 'text', required: true },
        ],
      }],
    };
    const json = JSON.stringify(redactForLogging(authState));
    assert.ok(!json.includes('SESSION_TOKEN_abc'), 'session token must not leak');
    assert.ok(!json.includes('JBSWY3DPEHPK3PXP'), 'TOTP shared secret must not leak');
    // Non-secret descriptor fields are preserved for debuggability.
    assert.ok(json.includes('confirmSignIn'));
    assert.ok(json.includes('Set Up Authenticator'));
  });

  it('leaves defaultValue untouched for a non-sensitive field (e.g. echoed username)', () => {
    const out = redactForLogging({
      name: 'username',
      type: 'hidden',
      defaultValue: 'alice',
    }) as Record<string, unknown>;
    assert.equal(out.defaultValue, 'alice');
  });

  it('handles circular references', () => {
    const a: Record<string, unknown> = { username: 'alice' };
    a.self = a;
    const out = redactForLogging(a) as Record<string, unknown>;
    assert.equal(out.username, 'alice');
    assert.equal(out.self, '[Circular]');
  });

  it('detects cycles nested deeper than the root', () => {
    const root: Record<string, unknown> = { level: 1 };
    const child: Record<string, unknown> = { level: 2, parent: root };
    root.child = child;
    const out = redactForLogging(root) as any;
    assert.equal(out.child.level, 2);
    assert.equal(out.child.parent, '[Circular]');
  });

  // Regression: `seen` must track the ancestor PATH, not every node ever
  // visited. A shared (non-cyclic) reference reached twice via sibling
  // branches must be emitted in full both times — a visited-set would wrongly
  // flag the second one as '[Circular]' and drop real data from the log.
  it('does not flag shared (non-circular) references as circular', () => {
    const shared = { region: 'us-east-1', count: 2 };
    const out = redactForLogging({ a: shared, b: shared }) as Record<string, unknown>;
    assert.deepEqual(out.a, shared);
    assert.deepEqual(out.b, shared);
  });

  it('emits a shared reference repeated in an array, not [Circular]', () => {
    const shared = { id: 'x' };
    const out = redactForLogging([shared, shared, shared]) as unknown[];
    assert.deepEqual(out, [shared, shared, shared]);
  });

  it('still redacts secrets inside a shared reference each time', () => {
    const shared = { username: 'u', password: 'secret' };
    const out = redactForLogging({ first: shared, second: shared }) as any;
    assert.equal(out.first.password, REDACTED);
    assert.equal(out.second.password, REDACTED);
    assert.equal(out.second.username, 'u');
  });

  // Regression: `code` is exact-match only, so substring siblings like
  // statusCode/errorCode stay visible — they carry no secret and masking them
  // defeats the debugging purpose of the logs.
  it('redacts an exact `code` field but not `code`-substring fields', () => {
    const out = redactForLogging({
      code: '123456',
      statusCode: 200,
      errorCode: 'E_BAD',
      countryCode: 'US',
      zipCode: '98101',
      qrCode: 'data:image/png',
    }) as Record<string, unknown>;
    assert.equal(out.code, REDACTED);
    assert.equal(out.statusCode, 200);
    assert.equal(out.errorCode, 'E_BAD');
    assert.equal(out.countryCode, 'US');
    assert.equal(out.zipCode, '98101');
    assert.equal(out.qrCode, 'data:image/png');
  });
});

describe('redactToJson', () => {
  it('serializes a redacted copy', () => {
    const json = redactToJson({ username: 'alice', password: 'hunter2' });
    assert.equal(json, JSON.stringify({ username: 'alice', password: REDACTED }));
  });

  it('returns a safe placeholder on serialization failure', () => {
    // BigInt is not JSON-serializable and survives redaction (not a sensitive key).
    assert.equal(redactToJson({ big: 10n }), '[unserializable]');
  });

  it('returns a string for undefined', () => {
    assert.equal(redactToJson(undefined), 'undefined');
  });

  it('returns a string for function values', () => {
    assert.equal(redactToJson(() => {}), 'undefined');
  });

  it('returns a string for symbol values', () => {
    assert.equal(redactToJson(Symbol('x')), 'undefined');
  });

  it('does not leak secrets even when truncation would apply downstream', () => {
    const json = redactToJson([{ action: 'signIn', username: 'u', password: 'p'.repeat(50) }]);
    assert.ok(!json.includes('pppp'));
    assert.ok(json.includes(REDACTED));
  });

  it('redacts secrets in a real JSON-RPC request body shape', () => {
    const body = {
      jsonrpc: '2.0',
      method: 'authApi.setAuthState',
      params: [{ action: 'signIn', username: 'a', password: 'hunter2' }],
      id: 1,
    };
    const json = redactToJson(body);
    assert.ok(!json.includes('hunter2'));
    assert.ok(json.includes(REDACTED));
    assert.ok(json.includes('setAuthState'), 'method name preserved for debugging');
  });
});
