import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  VERIFIED_NITRO_RANGE,
  extractJsonObjectAfter,
  parseNuxtImageDomains,
  patchNitroHandlerForApiGateway,
  resolveNitroBundlePath,
  warnIfNitroOutOfRange,
} from './nitro.js';
import { IPX_LAMBDA_HANDLER_SOURCE } from './ipx_lambda_template.js';

/**
 * Regression tests for the Nitro adapter internals that have caused
 * cross-OS production bugs. Targets:
 *   - `resolveNitroBundlePath` (chunks/nitro/ vs chunks/_/ vs other)
 *   - `patchNitroHandlerForApiGateway` (handler may live in any .mjs)
 *   - `extractJsonObjectAfter` (brace counter must survive strings,
 *     regex literals, escapes, template literals)
 */

const writeFile = (file: string, contents: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf-8');
};

const RAW_PATH_PATTERN = 'withQuery(event.rawPath, query)';
const METHOD_PATTERN = 'event.requestContext?.http?.method';

void describe('resolveNitroBundlePath', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-resolve-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  void it('returns chunks/nitro/nitro.mjs when present (Linux/macOS layout)', () => {
    const expected = path.join(tmp, 'chunks', 'nitro', 'nitro.mjs');
    writeFile(expected, '// nitro');
    assert.strictEqual(resolveNitroBundlePath(tmp), expected);
  });

  void it('falls back to chunks/_/nitro.mjs (Windows layout)', () => {
    const expected = path.join(tmp, 'chunks', '_', 'nitro.mjs');
    writeFile(expected, '// nitro');
    assert.strictEqual(resolveNitroBundlePath(tmp), expected);
  });

  void it('prefers chunks/nitro/ when both nitro/ and _/ contain nitro.mjs', () => {
    const preferred = path.join(tmp, 'chunks', 'nitro', 'nitro.mjs');
    writeFile(preferred, '// preferred');
    writeFile(path.join(tmp, 'chunks', '_', 'nitro.mjs'), '// fallback');
    assert.strictEqual(resolveNitroBundlePath(tmp), preferred);
  });

  void it('falls back to any chunks/<name>/nitro.mjs when known names are absent', () => {
    const expected = path.join(tmp, 'chunks', 'rolldown-runtime', 'nitro.mjs');
    writeFile(expected, '// future-naming');
    assert.strictEqual(resolveNitroBundlePath(tmp), expected);
  });

  void it('returns undefined when chunks/ does not exist', () => {
    assert.strictEqual(resolveNitroBundlePath(tmp), undefined);
  });

  void it('returns undefined when chunks/ exists but no nitro.mjs anywhere', () => {
    fs.mkdirSync(path.join(tmp, 'chunks', 'build'), { recursive: true });
    writeFile(path.join(tmp, 'chunks', 'build', 'index.mjs'), '// not nitro');
    assert.strictEqual(resolveNitroBundlePath(tmp), undefined);
  });
});

void describe('patchNitroHandlerForApiGateway', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-patch-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  void it('patches both patterns in chunks/nitro/nitro.mjs (POSIX layout)', () => {
    const bundle = path.join(tmp, 'chunks', 'nitro', 'nitro.mjs');
    writeFile(bundle, `${RAW_PATH_PATTERN};\n${METHOD_PATTERN};\n`);
    patchNitroHandlerForApiGateway(tmp);
    const out = fs.readFileSync(bundle, 'utf-8');
    assert.match(out, /event\.rawPath \|\| event\.path/);
    assert.match(out, /\|\| event\.requestContext\?\.httpMethod/);
  });

  void it('patches both patterns in chunks/_/nitro.mjs (Windows path layout)', () => {
    const bundle = path.join(tmp, 'chunks', '_', 'nitro.mjs');
    writeFile(bundle, `${RAW_PATH_PATTERN};\n${METHOD_PATTERN};\n`);
    patchNitroHandlerForApiGateway(tmp);
    const out = fs.readFileSync(bundle, 'utf-8');
    assert.match(out, /event\.rawPath \|\| event\.path/);
    assert.match(out, /\|\| event\.requestContext\?\.httpMethod/);
  });

  void it('patches index.mjs when patterns land there (Windows runtime grouping)', () => {
    // Real Windows behaviour: Nitro v2 prefix-match bug pulls runtime
    // into index.mjs instead of chunks/nitro/nitro.mjs.
    const indexFile = path.join(tmp, 'index.mjs');
    writeFile(indexFile, `${RAW_PATH_PATTERN};\n${METHOD_PATTERN};\n`);
    // chunks/_/nitro.mjs may exist but contain unrelated code.
    writeFile(
      path.join(tmp, 'chunks', '_', 'nitro.mjs'),
      '// no patterns here\n',
    );
    patchNitroHandlerForApiGateway(tmp);
    const out = fs.readFileSync(indexFile, 'utf-8');
    assert.match(out, /event\.rawPath \|\| event\.path/);
    assert.match(out, /\|\| event\.requestContext\?\.httpMethod/);
  });

  void it('patches the same pattern across multiple .mjs files when split by minifier', () => {
    const a = path.join(tmp, 'chunks', '_', 'nitro.mjs');
    const b = path.join(tmp, 'index.mjs');
    writeFile(a, `${RAW_PATH_PATTERN};\n`);
    writeFile(b, `${METHOD_PATTERN};\n`);
    patchNitroHandlerForApiGateway(tmp);
    assert.match(
      fs.readFileSync(a, 'utf-8'),
      /event\.rawPath \|\| event\.path/,
    );
    assert.match(
      fs.readFileSync(b, 'utf-8'),
      /\|\| event\.requestContext\?\.httpMethod/,
    );
  });

  void it('is idempotent — running twice does not double-patch', () => {
    const bundle = path.join(tmp, 'chunks', 'nitro', 'nitro.mjs');
    writeFile(bundle, `${RAW_PATH_PATTERN};\n${METHOD_PATTERN};\n`);
    patchNitroHandlerForApiGateway(tmp);
    const once = fs.readFileSync(bundle, 'utf-8');
    patchNitroHandlerForApiGateway(tmp);
    const twice = fs.readFileSync(bundle, 'utf-8');
    assert.strictEqual(
      once,
      twice,
      'second invocation must produce identical content',
    );
    // No "rawPath || event.path || event.path" double-OR.
    assert.doesNotMatch(twice, /\|\| event\.path \|\| event\.path/);
  });

  void it('does not touch non-.mjs files', () => {
    const mjs = path.join(tmp, 'chunks', 'nitro', 'nitro.mjs');
    const js = path.join(tmp, 'chunks', 'nitro', 'sibling.js');
    writeFile(mjs, RAW_PATH_PATTERN);
    writeFile(js, RAW_PATH_PATTERN);
    patchNitroHandlerForApiGateway(tmp);
    assert.match(
      fs.readFileSync(mjs, 'utf-8'),
      /event\.rawPath \|\| event\.path/,
    );
    assert.strictEqual(
      fs.readFileSync(js, 'utf-8'),
      RAW_PATH_PATTERN,
      'non-.mjs files must not be modified',
    );
  });

  void it('logs an info note and does not throw when no patterns are found', () => {
    // Nitro v3 (and any release with a REST-compatible request shape) needs
    // no patch — zero patches is a legitimate, working state, NOT an error.
    // The patch must skip gracefully: not throw, not corrupt the file. The
    // version-range warning (warnIfNitroOutOfRange) is the real "unverified
    // nitropack" signal; the patcher itself never hard-fails here.
    const bundle = path.join(tmp, 'chunks', 'nitro', 'nitro.mjs');
    writeFile(bundle, '// completely refactored, no patterns here\n');
    const original = fs.readFileSync(bundle, 'utf-8');

    const stderrChunks: string[] = [];
    const writeOriginal = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.doesNotThrow(() => patchNitroHandlerForApiGateway(tmp));
    } finally {
      process.stderr.write = writeOriginal;
    }

    assert.strictEqual(
      fs.readFileSync(bundle, 'utf-8'),
      original,
      'bundle must be untouched when no patterns matched',
    );
    const out = stderrChunks.join('');
    assert.ok(
      out.includes('found nothing to change'),
      'must emit a no-op note',
    );
    // Must NOT be framed as a hard warning/error — zero patches is expected
    // on v3. (Info-level marker, mentions the v3 "no patch needed" case.)
    assert.ok(
      out.includes('ℹ️') && out.includes('Nitro v3'),
      'note must reassure that zero patches is expected on v3+',
    );
  });

  void it('does not crash when serverDir does not exist', () => {
    assert.doesNotThrow(() =>
      patchNitroHandlerForApiGateway(path.join(tmp, 'does', 'not', 'exist')),
    );
  });
});

void describe('warnIfNitroOutOfRange', () => {
  let tmp: string;
  let stderrChunks: string[];
  let restoreStderr: (() => void) | undefined;

  const writeNitropack = (version: string): void => {
    const pkgDir = path.join(tmp, 'node_modules', 'nitropack');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'nitropack', version }),
    );
  };

  const captureStderr = (): void => {
    stderrChunks = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    restoreStderr = () => {
      process.stderr.write = original;
    };
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-ver-'));
    captureStderr();
  });
  afterEach(() => {
    restoreStderr?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  void it('does NOT warn when nitropack is in the verified range', () => {
    writeNitropack('2.13.0');
    warnIfNitroOutOfRange(tmp);
    assert.ok(
      !stderrChunks.join('').includes('outside the version range'),
      `unexpected warning; stderr: ${stderrChunks.join('')}`,
    );
  });

  void it('warns when nitropack is above the verified upper bound (e.g. v3)', () => {
    writeNitropack('3.0.0');
    warnIfNitroOutOfRange(tmp);
    const out = stderrChunks.join('');
    assert.ok(
      out.includes('nitropack@3.0.0') &&
        out.includes('outside the version range'),
      `expected version warning; stderr: ${out}`,
    );
  });

  void it('does NOT warn (or crash) when nitropack is not installed', () => {
    warnIfNitroOutOfRange(tmp);
    assert.ok(
      !stderrChunks.join('').includes('outside the version range'),
      'should be silent when nitropack is absent',
    );
  });

  void it('VERIFIED_NITRO_RANGE is a parseable range with an explicit upper bound', () => {
    assert.ok(VERIFIED_NITRO_RANGE.includes('<'), 'must have an upper bound');
  });
});

void describe('extractJsonObjectAfter', () => {
  void it('extracts a flat object', () => {
    const src = 'config = { "routeRules": {"a": 1} };';
    assert.strictEqual(
      extractJsonObjectAfter(src, '"routeRules":'),
      '{"a": 1}',
    );
  });

  void it('handles nested braces in the JSON object', () => {
    const src = 'x = { "routeRules": {"a": {"b": {"c": 1}}} };';
    assert.strictEqual(
      extractJsonObjectAfter(src, '"routeRules":'),
      '{"a": {"b": {"c": 1}}}',
    );
  });

  void it('does not mistake `{` inside a string literal for an opening brace', () => {
    // A double-quoted string in JSON containing `{` and `}` literals
    // must not throw off the brace counter.
    const src = 'cfg = { "routeRules": {"k": "value with { and } in it"} }';
    const blob = extractJsonObjectAfter(src, '"routeRules":');
    assert.strictEqual(
      blob,
      '{"k": "value with { and } in it"}',
      'string-literal braces must not affect depth tracking',
    );
    // Must round-trip through JSON.parse.
    assert.deepStrictEqual(JSON.parse(blob!), {
      k: 'value with { and } in it',
    });
  });

  void it('handles escaped quotes inside string literals', () => {
    const src =
      'cfg = { "routeRules": {"k": "escaped \\"quote\\" then { inside"} }';
    const blob = extractJsonObjectAfter(src, '"routeRules":');
    assert.ok(blob, 'must extract a blob');
    assert.deepStrictEqual(JSON.parse(blob!), {
      k: 'escaped "quote" then { inside',
    });
  });

  void it('handles escaped backslash before a quote', () => {
    // The sequence `\\"` is a real backslash followed by an unescaped
    // quote — closes the string. Counter must not get stuck inside.
    const src = 'cfg = { "routeRules": {"k": "ends with backslash\\\\"} }';
    const blob = extractJsonObjectAfter(src, '"routeRules":');
    assert.ok(blob, 'must extract a blob');
    assert.deepStrictEqual(JSON.parse(blob!), {
      k: 'ends with backslash\\',
    });
  });

  void it('returns undefined when marker is absent', () => {
    assert.strictEqual(
      extractJsonObjectAfter('no marker here', '"routeRules":'),
      undefined,
    );
  });

  void it('returns undefined when no opening brace follows the marker', () => {
    assert.strictEqual(
      extractJsonObjectAfter('"routeRules": null', '"routeRules":'),
      undefined,
    );
  });

  void it('returns undefined for unbalanced braces (corrupt input)', () => {
    // An unterminated object — the counter never reaches depth 0.
    const src = '{ "routeRules": {"a": 1';
    assert.strictEqual(extractJsonObjectAfter(src, '"routeRules":'), undefined);
  });

  void it('finds the FIRST occurrence of the marker', () => {
    const src =
      '{ "other": {"x": "irrelevant"}, "routeRules": {"a": 1}, "routeRules": {"b": 2} }';
    assert.strictEqual(
      extractJsonObjectAfter(src, '"routeRules":'),
      '{"a": 1}',
    );
  });
});

describe('parseNuxtImageDomains (image.domains allowlist scan)', () => {
  it('reads a simple image.domains array', () => {
    const src = `export default defineNuxtConfig({
      image: { domains: ['a.com', "b.com"] },
    })`;
    assert.deepStrictEqual(parseNuxtImageDomains(src), ['a.com', 'b.com']);
  });

  it('reads domains even when a nested object precedes it (brace balancing)', () => {
    // Regression: a non-greedy `image:{…}?` match truncated at the first `}`
    // (the end of `provider`), missing domains entirely → [].
    const src = `export default defineNuxtConfig({
      image: {
        provider: 'ipx',
        providers: { ipx: { options: { maxAge: 60 } } },
        domains: ['images.unsplash.com', 'picsum.photos'],
      },
    })`;
    assert.deepStrictEqual(parseNuxtImageDomains(src), [
      'images.unsplash.com',
      'picsum.photos',
    ]);
  });

  it('returns [] when there is no image block', () => {
    assert.deepStrictEqual(parseNuxtImageDomains('export default {}'), []);
  });

  it('returns [] when image block has no domains', () => {
    const src = `export default { image: { provider: { name: 'ipx' } } }`;
    assert.deepStrictEqual(parseNuxtImageDomains(src), []);
  });

  it('is not fooled by a brace inside a string value before domains', () => {
    const src = `export default { image: { note: 'a } b', domains: ['x.com'] } }`;
    assert.deepStrictEqual(parseNuxtImageDomains(src), ['x.com']);
  });
});

void describe('IPX_LAMBDA_HANDLER_SOURCE — remote source support (issue #2)', () => {
  // The handler template is inline code shipped as a string; assert the
  // wiring that makes remote images work end-to-end.
  it('imports and configures IPX httpStorage for remote (http/https) sources', () => {
    // Without httpStorage, IPX routes a remote id to the S3 storage → 404
    // IPX_RESOURCE_NOT_FOUND. It must be imported and wired, gated on the
    // allowlist domains.
    assert.match(IPX_LAMBDA_HANDLER_SOURCE, /ipxHttpStorage/);
    assert.match(IPX_LAMBDA_HANDLER_SOURCE, /httpStorage: ipxHttpStorage\(\{ domains: httpDomains \}\)/);
    // Domains come from the same allowlist the handler enforces.
    assert.match(IPX_LAMBDA_HANDLER_SOURCE, /const httpDomains = \[/);
  });

  it('accepts BOTH API Gateway REST (v1) and Function URL (v2) events', () => {
    // Shared SSR API GW delivers v1 (path/httpMethod); the fallback Function
    // URL delivers v2 (rawPath/rawQueryString). eventToRequest must branch.
    assert.match(IPX_LAMBDA_HANDLER_SOURCE, /event\.rawPath/);
    assert.match(IPX_LAMBDA_HANDLER_SOURCE, /event\.path/);
    assert.match(IPX_LAMBDA_HANDLER_SOURCE, /event\.httpMethod/);
    assert.match(IPX_LAMBDA_HANDLER_SOURCE, /multiValueQueryStringParameters/);
  });
});
