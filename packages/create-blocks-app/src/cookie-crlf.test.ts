import { test } from 'node:test';
import assert from 'node:assert';

/**
 * Mirror of the cookie helpers in the demo template (aws-blocks/index.ts).
 * The template's public setCookie/deleteCookie API methods write a user-controlled
 * name/value into the Set-Cookie response header. Without rejecting CR/LF, an
 * attacker could inject additional headers (HTTP response splitting). We mirror the
 * guard + header builder here so the unit test runs without a browser or dev server.
 */
function assertNoCrlf(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Invalid cookie ${field}: must not contain CR or LF characters`);
  }
}

function buildSetCookie(name: string, value: string): string {
  assertNoCrlf(name, 'name');
  assertNoCrlf(value, 'value');
  return `${name}=${value}; Max-Age=3600; Secure; SameSite=None; Partitioned`;
}

function buildDeleteCookie(name: string): string {
  assertNoCrlf(name, 'name');
  return `${name}=; Max-Age=0; Secure; SameSite=None; Partitioned`;
}

test('setCookie - builds a valid Set-Cookie header for clean input', () => {
  assert.strictEqual(
    buildSetCookie('session', 'abc123'),
    'session=abc123; Max-Age=3600; Secure; SameSite=None; Partitioned'
  );
});

test('deleteCookie - builds a valid expiry Set-Cookie header for clean input', () => {
  assert.strictEqual(
    buildDeleteCookie('session'),
    'session=; Max-Age=0; Secure; SameSite=None; Partitioned'
  );
});

test('setCookie - rejects CRLF injection in the cookie value', () => {
  const malicious = 'x\r\nSet-Cookie: admin=true';
  assert.throws(() => buildSetCookie('session', malicious), /must not contain CR or LF/);
});

test('setCookie - rejects CRLF injection in the cookie name', () => {
  const malicious = 'session\r\nLocation: https://evil.example';
  assert.throws(() => buildSetCookie(malicious, 'abc123'), /must not contain CR or LF/);
});

test('setCookie - rejects a bare LF and a bare CR', () => {
  assert.throws(() => buildSetCookie('a', 'b\nc'), /must not contain CR or LF/);
  assert.throws(() => buildSetCookie('a', 'b\rc'), /must not contain CR or LF/);
});

test('deleteCookie - rejects CRLF injection in the cookie name', () => {
  const malicious = 'session\r\nSet-Cookie: admin=true';
  assert.throws(() => buildDeleteCookie(malicious), /must not contain CR or LF/);
});
