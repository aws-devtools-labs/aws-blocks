import { test } from 'node:test';
import assert from 'node:assert';

/**
 * Mirror of the cookie helpers in the demo template (aws-blocks/index.ts).
 * The template's public setCookie API method writes a user-controlled value into
 * the Set-Cookie response header. The cookie name is fixed (callers can't pick
 * it, so they can't overwrite the auth session cookie), and the value is
 * URI-encoded so CR/LF can't split the response (header injection) and `;`
 * can't append cookie attributes (e.g. `Domain=`). We mirror the header builder
 * here so the unit test runs without a browser or dev server;
 * templates-security-defaults.test.ts checks the template itself keeps these
 * attributes.
 */
const DEMO_COOKIE = 'blocks-demo';
const DEMO_COOKIE_ATTRS = 'HttpOnly; Secure; SameSite=Lax';

function buildSetCookie(value: string): string {
  return `${DEMO_COOKIE}=${encodeURIComponent(value)}; Max-Age=3600; ${DEMO_COOKIE_ATTRS}`;
}

function buildDeleteCookie(): string {
  return `${DEMO_COOKIE}=; Max-Age=0; ${DEMO_COOKIE_ATTRS}`;
}

function readCookie(cookieHeader: string): string | null {
  const match = cookieHeader.split('; ').find(c => c.startsWith(`${DEMO_COOKIE}=`));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(DEMO_COOKIE.length + 1));
  } catch {
    return null;
  }
}

test('setCookie - builds a fixed-name HttpOnly SameSite=Lax header for clean input', () => {
  assert.strictEqual(
    buildSetCookie('abc123'),
    'blocks-demo=abc123; Max-Age=3600; HttpOnly; Secure; SameSite=Lax'
  );
});

test('deleteCookie - builds a valid expiry Set-Cookie header', () => {
  assert.strictEqual(
    buildDeleteCookie(),
    'blocks-demo=; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
  );
});

test('setCookie - neutralises CRLF injection in the cookie value', () => {
  const header = buildSetCookie('x\r\nSet-Cookie: admin=true');
  assert.doesNotMatch(header, /[\r\n]/);
  assert.strictEqual(readCookie(header.split(';')[0]), 'x\r\nSet-Cookie: admin=true');
});

test('setCookie - neutralises cookie-attribute injection via ";"', () => {
  const header = buildSetCookie('x; Domain=evil.example; SameSite=None');
  assert.strictEqual(header.split(';').length, 5, 'value must not add attributes');
  assert.doesNotMatch(header, /Domain=|SameSite=None/);
});

test('getCookie - round-trips the encoded value and ignores other cookies', () => {
  const pair = buildSetCookie('a b;c=d').split(';')[0];
  assert.strictEqual(readCookie(`session=xyz; ${pair}`), 'a b;c=d');
  assert.strictEqual(readCookie('session=xyz'), null);
});

test('getCookie - returns null for a malformed client-sent value', () => {
  assert.strictEqual(readCookie('blocks-demo=%E0%A4%A'), null);
});
