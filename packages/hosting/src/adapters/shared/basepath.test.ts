import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeBasePath, prependBasePath } from './basepath.js';

void describe('normalizeBasePath', () => {
  void it('returns undefined for undefined', () => {
    assert.strictEqual(normalizeBasePath(undefined), undefined);
  });

  void it('returns undefined for empty string', () => {
    assert.strictEqual(normalizeBasePath(''), undefined);
  });

  void it('returns undefined for "/"', () => {
    assert.strictEqual(normalizeBasePath('/'), undefined);
  });

  void it('drops trailing slash', () => {
    assert.strictEqual(normalizeBasePath('/app/'), '/app');
  });

  void it('preserves a value with leading slash and no trailing', () => {
    assert.strictEqual(normalizeBasePath('/app'), '/app');
  });

  void it('prepends leading slash when missing', () => {
    assert.strictEqual(normalizeBasePath('app'), '/app');
  });

  void it('handles nested path', () => {
    assert.strictEqual(normalizeBasePath('/foo/bar/'), '/foo/bar');
  });

  void it('trims whitespace', () => {
    assert.strictEqual(normalizeBasePath('  /app  '), '/app');
  });
});

void describe('prependBasePath', () => {
  void it('returns the pattern unchanged when basePath is undefined', () => {
    assert.strictEqual(prependBasePath(undefined, '/foo/*'), '/foo/*');
  });

  void it('returns the pattern unchanged when basePath is empty string', () => {
    assert.strictEqual(prependBasePath('', '/foo/*'), '/foo/*');
  });

  void it('prepends basePath to a slash-prefixed pattern', () => {
    assert.strictEqual(prependBasePath('/app', '/foo/*'), '/app/foo/*');
  });

  void it('prepends basePath to a pattern without leading slash', () => {
    assert.strictEqual(prependBasePath('/app', 'foo'), '/app/foo');
  });

  void it('handles root pattern "/"', () => {
    assert.strictEqual(prependBasePath('/app', '/'), '/app/');
  });

  void it('handles empty pattern', () => {
    assert.strictEqual(prependBasePath('/app', ''), '/app/');
  });

  void it('handles wildcard pattern', () => {
    assert.strictEqual(prependBasePath('/app', '/*'), '/app/*');
  });

  void it('handles nested basePath', () => {
    assert.strictEqual(prependBasePath('/foo/bar', '/baz'), '/foo/bar/baz');
  });

  // Idempotency guard — a pattern ALREADY under basePath is not prefixed twice.
  // Next.js bakes basePath into its OpenNext patterns + routes-manifest sources,
  // so they arrive pre-prefixed; double-prefixing to /app/app/* breaks routing.
  void it('does not double-prefix a pattern already under basePath', () => {
    assert.strictEqual(prependBasePath('/app', '/app/_next/*'), '/app/_next/*');
  });

  void it('does not double-prefix the basePath root itself', () => {
    assert.strictEqual(prependBasePath('/app', '/app'), '/app');
  });

  void it('still prefixes a relative pattern that shares a prefix substring (boundary-safe)', () => {
    // `/application/*` is NOT under basePath `/app` (no `/app/` boundary), so it
    // must still be prefixed rather than mistaken for already-prefixed.
    assert.strictEqual(
      prependBasePath('/app', '/application/*'),
      '/app/application/*',
    );
  });

  void it('is idempotent: prepending twice equals prepending once', () => {
    const once = prependBasePath('/app', '/foo/*');
    assert.strictEqual(prependBasePath('/app', once), once);
  });

  // Slash normalization (edge 500 safety net) — the result never contains `//`.
  void it('collapses a double slash in an already-prefixed pattern', () => {
    assert.strictEqual(prependBasePath('/app', '/app//edge'), '/app/edge');
  });

  void it('collapses double slashes when basePath is undefined', () => {
    assert.strictEqual(prependBasePath(undefined, '/app//edge'), '/app/edge');
  });

  void it('never emits // when joining basePath and a leading-slash pattern', () => {
    // basePath + pattern must not produce /app//foo even for odd inputs.
    assert.strictEqual(prependBasePath('/app', 'foo//bar'), '/app/foo/bar');
  });
});
