// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

/**
 * The client lazily loads `node:fs` to read `.blocks-sandbox/config.json`
 * under Node.js. That load must keep working in Node while staying invisible
 * to browser bundlers, which otherwise warn that `node:fs` was externalized.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_MODULE = join(__dirname, 'index.js');

describe('client node:fs config loading', () => {
  it('reads .blocks-sandbox/config.json from the working directory under Node.js', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'blocks-client-fs-'));
    try {
      mkdirSync(join(tmp, '.blocks-sandbox'));
      writeFileSync(
        join(tmp, '.blocks-sandbox', 'config.json'),
        JSON.stringify({ apiUrl: 'http://127.0.0.1:1/api' }),
      );
      const script = join(tmp, 'test.mjs');
      writeFileSync(
        script,
        `import { ApiNamespaceClient } from '${pathToFileURL(CLIENT_MODULE).href}';
try { await ApiNamespaceClient('test').hello(); } catch {}
`,
      );
      const out = execFileSync(process.execPath, [script], {
        cwd: tmp,
        encoding: 'utf-8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        timeout: 10000,
      });
      assert.match(out, /Using API \(config\.json file\): http:\/\/127\.0\.0\.1:1\/api/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('builds for the browser with Vite without externalizing node:fs', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'blocks-client-vite-'));
    try {
      writeFileSync(
        join(tmp, 'main.js'),
        `import { ApiNamespaceClient } from ${JSON.stringify(CLIENT_MODULE)};\nconsole.log(ApiNamespaceClient);\n`,
      );
      writeFileSync(join(tmp, 'index.html'), '<script type="module" src="./main.js"></script>\n');
      const warnings: string[] = [];
      await build({
        root: tmp,
        configFile: false,
        logLevel: 'silent',
        build: { outDir: join(tmp, 'dist'), write: false },
        customLogger: {
          info() {},
          warn: (msg) => warnings.push(msg),
          warnOnce: (msg) => warnings.push(msg),
          error: (msg) => warnings.push(msg),
          clearScreen() {},
          hasErrorLogged: () => false,
          hasWarned: false,
        },
      });
      const nodeFs = warnings.filter((w) => w.includes('node:fs'));
      assert.deepStrictEqual(nodeFs, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
