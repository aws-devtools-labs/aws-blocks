// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMigrationInstructions } from './instructions.js';

const dir = mkdtempSync(join(tmpdir(), 'vendorize-instructions-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function instructions(binNames?: string[]): string {
  writeMigrationInstructions(dir, '@aws-blocks/bb-data', 'bb-data', binNames);
  return readFileSync(join(dir, 'VENDORIZE.md'), 'utf-8');
}

/** The commands of the fenced bash block that follows `heading` (a line prefix). */
function commandsAfter(doc: string, heading: string): string[] {
  const rest = doc.slice(doc.indexOf(heading));
  const block = /```bash\n([\s\S]*?)```/.exec(rest);
  assert.ok(block, `no bash block after "${heading}"`);
  return block[1].split('\n').filter(line => line.trim() !== '' && !line.startsWith('#'));
}

describe('writeMigrationInstructions', () => {
  test('re-vendorizes with --force through the vendorize bin, not after deleting vendor/', () => {
    // `npm run vendorize <pkg> --force` would hand --force to npm, and the
    // command can't resolve the package once vendor/<pkg> is deleted.
    assert.deepStrictEqual(commandsAfter(instructions(), 'To re-vendorize'), [
      'npx blocks-vendorize @aws-blocks/bb-data --force',
    ]);
  });

  test('reverts with npm update, which replaces the lockfile link to vendor/', () => {
    assert.match(instructions(), /root `package.json` and run `npm update @aws-blocks\/bb-data`\./);
  });

  test('compares against upstream with the published tarball', () => {
    assert.deepStrictEqual(commandsAfter(instructions(), '## Updating from upstream'), [
      'mkdir -p .upstream',
      'npm pack @aws-blocks/bb-data@latest --pack-destination .upstream',
      'tar -xzf .upstream/*.tgz -C .upstream',
      'diff -ru .upstream/package/src vendor/bb-data/src',
      'rm -rf .upstream',
    ]);
  });

  test('lists the kept bin commands', () => {
    assert.match(instructions(['bb-data']), /- `bin` commands \(`bb-data`\) kept; they run `src\/` through `tsx`/);
    assert.doesNotMatch(instructions(), /`bin` commands/);
  });
});
