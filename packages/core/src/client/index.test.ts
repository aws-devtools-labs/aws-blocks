// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Tests for the client's URL resolution defensive guard (issue #730).
 *
 * The client module caches API_URL globally, so each test spawns a
 * subprocess with appropriate env vars to get a fresh module instance.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_MODULE = join(__dirname, '..', 'client', 'index.js');

function runScript(scriptBody: string, env: Record<string, string>, cwd?: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'blocks-client-test-'));
  const scriptPath = join(tmp, 'test.mjs');
  // Use absolute path to import the client module
  const importPath = `file://${CLIENT_MODULE}`;
  const fullScript = `import { ApiNamespaceClient } from '${importPath}';\n${scriptBody}`;
  writeFileSync(scriptPath, fullScript);
  try {
    return execSync(`node ${scriptPath}`, {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      cwd,
      timeout: 10000,
    }).trim();
  } finally {
    try { unlinkSync(scriptPath); } catch {}
  }
}

describe('Client URL validation (issue #730)', () => {
  it('ApiNamespaceClient with explicit url option containing "undefined" does NOT throw on creation', async () => {
    const { ApiNamespaceClient } = await import('./index.js');
    const client = ApiNamespaceClient('test', { url: 'https://undefined.example.com' });
    assert.ok(client, 'Should create client proxy');
  });

  it('resolveApiUrl rejects when BLOCKS_API_URL contains "undefined"', () => {
    const result = runScript(`
const api = ApiNamespaceClient('test');
try {
  await api.hello();
  console.log('FAIL:no_error');
} catch (e) {
  if (e.message.includes('Blocks API URL is not configured')) {
    console.log('PASS');
  } else {
    console.log('FAIL:' + e.message);
  }
}
`, { BLOCKS_API_URL: 'https://undefined/api' });
    assert.ok(result.includes('PASS'), `Expected PASS, got: ${result}`);
  });

  it('resolveApiUrl rejects when BLOCKS_CONFIG has missing apiUrl', () => {
    const result = runScript(`
const api = ApiNamespaceClient('test');
try {
  await api.hello();
  console.log('FAIL:no_error');
} catch (e) {
  if (e.message.includes('Blocks API URL is not configured') || e.message.includes('Blocks API URL not configured')) {
    console.log('PASS');
  } else {
    console.log('FAIL:' + e.message);
  }
}
`, { BLOCKS_CONFIG: JSON.stringify({ region: 'us-east-1' }) });
    assert.ok(result.includes('PASS'), `Expected PASS, got: ${result}`);
  });

  it('resolveApiUrl succeeds with valid BLOCKS_API_URL', () => {
    const result = runScript(`
const api = ApiNamespaceClient('test');
try {
  await api.hello();
  console.log('FAIL:no_error');
} catch (e) {
  if (e.message.includes('fetch') || e.message.includes('ENOTFOUND') || e.message.includes('getaddrinfo')) {
    console.log('PASS:url_resolved_fetch_failed');
  } else if (e.message.includes('Blocks API URL')) {
    console.log('FAIL:url_rejected_valid');
  } else {
    console.log('PASS:other');
  }
}
`, { BLOCKS_API_URL: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks' });
    assert.ok(result.includes('PASS'), `Expected PASS, got: ${result}`);
  });

  it('resolveApiUrl accepts relative URLs (e.g. /aws-blocks/api for SPA hosting)', () => {
    const result = runScript(`
const api = ApiNamespaceClient('test');
try {
  await api.hello();
  console.log('FAIL:no_error');
} catch (e) {
  if (e.message.includes('fetch') || e.message.includes('ENOTFOUND') || e.message.includes('getaddrinfo') || e.message.includes('Invalid URL')) {
    console.log('PASS:url_resolved_fetch_failed');
  } else if (e.message.includes('Blocks API URL')) {
    console.log('FAIL:url_rejected_relative');
  } else {
    console.log('PASS:other');
  }
}
`, { BLOCKS_API_URL: '/aws-blocks/api' });
    assert.ok(result.includes('PASS'), `Expected PASS, got: ${result}`);
  });
});

/**
 * The client entry is bundled for browsers and React Native. Expo's Metro
 * honors `webpackIgnore` and leaves a dynamic `import()` in the bundle, which
 * Hermes cannot compile — so the client must never contain a dynamic import of
 * a Node builtin, even behind a runtime `process.versions.node` guard.
 */
describe('Client bundle safety (React Native / Hermes)', () => {
  const NODE_DYNAMIC_IMPORT = /\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)*['"`]node:/;

  function listJs(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return listJs(full);
      return entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [full] : [];
    });
  }

  it('dist/client contains no dynamic import() of node: builtins', () => {
    const files = listJs(dirname(CLIENT_MODULE));
    assert.ok(files.length > 0, 'expected compiled client files');
    const offenders = files.filter((file) => NODE_DYNAMIC_IMPORT.test(readFileSync(file, 'utf-8')));
    assert.deepStrictEqual(offenders, [], `dynamic import() of a node: builtin breaks Hermes: ${offenders.join(', ')}`);
  });

  it('still reads .blocks-sandbox/config.json from the working directory under Node', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'blocks-client-cwd-'));
    mkdirSync(join(projectDir, '.blocks-sandbox'));
    writeFileSync(
      join(projectDir, '.blocks-sandbox', 'config.json'),
      JSON.stringify({ apiUrl: 'https://from-config-file.example.com/aws-blocks' }),
    );
    const result = runScript(`
globalThis.fetch = async (url) => {
  console.log('FETCH:' + String(url));
  throw new Error('stop');
};
const api = ApiNamespaceClient('test');
try { await api.hello(); } catch {}
`, {}, projectDir);
    assert.ok(
      result.includes('FETCH:https://from-config-file.example.com/aws-blocks'),
      `Expected the request to use the config.json apiUrl, got: ${result}`,
    );
  });
});
