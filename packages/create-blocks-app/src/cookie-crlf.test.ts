import { test } from 'node:test';
import assert from 'node:assert';

/**
 * Mirror of the cookie helpers in the demo template (aws-blocks/index.ts).
 * The template's public setCookie API method writes a user-controlled value into
 * the Set-Cookie response header. The cookie name is fixed (callers can't pick
 * it, so they can't overwrite the auth session cookie), and the value is
 * URI-encoded so CR/LF can't split the response (header injection) and `;`
 * can't append cookie attributes (e.g. `Domain=`). We mirror the header builder
 * here as fast documentation of the encoding; it is a copy, so it can't catch a
 * regression in the template. The demo's own test/e2e.test.ts runs the real
 * methods with a hostile value, and templates-security-defaults.test.ts checks
 * the template keeps these attributes.
 */
const DEMO_COOKIE = 'blocks-demo';
const DEMO_COOKIE_ATTRS = 'HttpOnly; SameSite=Lax';

/** `Secure` everywhere except plain-HTTP localhost, like the auth cookie. */
function demoCookieAttrs(headers: Headers): string {
  const origin = headers.get('origin') ?? headers.get('host') ?? '';
  const isLoopback = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/.test(origin);
  return isLoopback ? DEMO_COOKIE_ATTRS : `${DEMO_COOKIE_ATTRS}; Secure`;
}

const PROD = new Headers({ origin: 'https://app.example.com' });

function buildSetCookie(value: string, headers: Headers = PROD): string {
  return `${DEMO_COOKIE}=${encodeURIComponent(value)}; Max-Age=3600; ${demoCookieAttrs(headers)}`;
}

function buildDeleteCookie(headers: Headers = PROD): string {
  return `${DEMO_COOKIE}=; Max-Age=0; ${demoCookieAttrs(headers)}`;
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
    'blocks-demo=abc123; Max-Age=3600; HttpOnly; SameSite=Lax; Secure'
  );
});

test('setCookie - omits Secure only on plain-HTTP localhost', () => {
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:5173', 'http://[::1]:3000']) {
    assert.doesNotMatch(buildSetCookie('v', new Headers({ origin })), /Secure/, origin);
  }
  assert.doesNotMatch(buildSetCookie('v', new Headers({ host: 'localhost:3000' })), /Secure/);
  for (const origin of ['https://app.example.com', 'http://localhost.evil.example', 'http://evil.example/localhost']) {
    assert.match(buildSetCookie('v', new Headers({ origin })), /; Secure$/, origin);
  }
});

test('deleteCookie - builds a valid expiry Set-Cookie header', () => {
  assert.strictEqual(
    buildDeleteCookie(),
    'blocks-demo=; Max-Age=0; HttpOnly; SameSite=Lax; Secure'
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
