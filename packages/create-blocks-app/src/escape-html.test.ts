import { test } from 'node:test';
import assert from 'node:assert';

/**
 * Mirror of the escapeHtml helper added to the demo template (src/index.ts).
 * We test it here so the unit test runs without needing a browser or dev server.
 */
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

test('escapeHtml - escapes script tags', () => {
  const input = '<script>alert(1)</script>';
  const result = escapeHtml(input);
  assert.strictEqual(result, '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.ok(!result.includes('<script>'));
});

test('escapeHtml - escapes ampersands', () => {
  assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
});

test('escapeHtml - escapes double quotes', () => {
  assert.strictEqual(escapeHtml('value="xss"'), 'value=&quot;xss&quot;');
});

test('escapeHtml - escapes angle brackets in attribute injection', () => {
  const input = '"><img src=x onerror=alert(1)>';
  const result = escapeHtml(input);
  assert.strictEqual(result, '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  assert.ok(!result.includes('<img'));
});

test('escapeHtml - preserves safe strings unchanged', () => {
  assert.strictEqual(escapeHtml('hello world'), 'hello world');
  assert.strictEqual(escapeHtml('key-123_abc'), 'key-123_abc');
});

test('escapeHtml - handles empty string', () => {
  assert.strictEqual(escapeHtml(''), '');
});

test('escapeHtml - handles string with all special chars', () => {
  assert.strictEqual(escapeHtml('&<>"'), '&amp;&lt;&gt;&quot;');
});
