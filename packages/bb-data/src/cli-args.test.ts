// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * An option-looking token where `bb-data` expects a path (`[dir]`, `[output]`,
 * `[output-dir]`) is a usage error (exit 2), never a file or directory name.
 * `cdk-blocks db <verb> --no-input` forwards `--no-input` here, which used to make
 * `generate-types` write a file named `--no-input`.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/_(DB_URL|CONNECTION_STRING)$/.test(name) && name !== 'BLOCKS_MIGRATE_URL'),
);

let dir: string;

function run(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'bb-data-cli-args-'));
  mkdirSync(join(dir, 'migrations'));
  writeFileSync(join(dir, 'migrations', '001_notes.sql'), 'CREATE TABLE notes (n INT PRIMARY KEY);\n');
  // A local database, so generate-types gets as far as writing its output.
  const r = run(['migrate', 'migrations', '--block', 'app-main']);
  assert.strictEqual(r.status, 0, r.stderr);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const cases: Array<[verb: string, args: string[]]> = [
  ['generate-types', ['--no-input']],
  ['generate-types', ['-y']],
  ['generate-types', ['--', '--no-input']],
  ['migrate', ['--no-input', 'migrations']],
  ['status', ['-y']],
  ['pull', ['-y']],
];

for (const [verb, args] of cases) {
  test(`${verb} ${args.join(' ')}: usage error (exit 2), nothing written`, () => {
    const entries = readdirSync(dir).sort();
    const r = run([verb, ...args]);
    assert.strictEqual(r.status, 2, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, new RegExp(`bb-data ${verb}: unexpected option "${args[0]}" where a path is expected`));
    assert.deepStrictEqual(readdirSync(dir).sort(), entries);
    for (const token of args.filter((a) => a.startsWith('-'))) assert.strictEqual(existsSync(join(dir, token)), false);
  });
}

test('generate-types still writes to a real output path', () => {
  const r = run(['generate-types', 'out/types.ts']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Types written to out\/types\.ts/);
  assert.strictEqual(existsSync(join(dir, 'out', 'types.ts')), true);
});
