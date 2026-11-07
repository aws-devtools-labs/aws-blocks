import { describe, it } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

// Scaffolded e2e tests must not import `setTimeout` from 'node:timers/promises'
// under its own name: that shadows the global `setTimeout(cb, ms)` for every test
// a user adds to the file. Import it under another name (e.g. `sleep`).
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '../templates');
const SHADOW = /import\s*\{[^}]*\bsetTimeout\b(?!\s+as\b)[^}]*\}\s*from\s*['"]node:timers\/promises['"]/;

const testFiles = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(TEMPLATES_DIR, entry.name, 'test/e2e.test.ts'))
  .filter((file) => existsSync(file));

describe('create-blocks-app template tests keep the global setTimeout', () => {
  it('discovers template e2e tests to check', () => {
    assert.ok(testFiles.length > 0, `no template e2e tests found under ${TEMPLATES_DIR}`);
  });

  for (const file of testFiles) {
    it(`${file.slice(TEMPLATES_DIR.length + 1)} does not shadow setTimeout`, () => {
      assert.doesNotMatch(readFileSync(file, 'utf-8'), SHADOW);
    });
  }
});
