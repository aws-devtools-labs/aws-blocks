import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { excludeBackendFromFrontendTsconfigs, excludeBackendInTsconfig } from './tsconfig-exclude.js';

/** Parse a tsconfig the way TypeScript does (JSONC) and fail on syntax errors. */
function parse(file: string): { exclude?: string[]; [key: string]: unknown } {
  const { config, error } = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf-8'));
  assert.strictEqual(error, undefined, `TypeScript cannot parse ${file}`);
  return config;
}

describe('excludeBackendInTsconfig', () => {
  let dir: string;
  const write = (name: string, text: string) => {
    const file = join(dir, name);
    writeFileSync(file, text);
    return file;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tsconfig-exclude-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds exclude to a `tsc --init` config (no include, comments, trailing comma) and keeps the comments', () => {
    const file = write(
      'tsconfig.json',
      `{
  // Visit https://aka.ms/tsconfig to read more about this file
  "compilerOptions": {
    "module": "nodenext",
    /* Environment Settings */
    "types": [],
    "strict": true,
  }
}
`,
    );
    assert.strictEqual(excludeBackendInTsconfig(file).status, 'updated');
    const text = readFileSync(file, 'utf-8');
    assert.match(text, /\/\/ Visit https:\/\/aka\.ms\/tsconfig/);
    assert.match(text, /\/\* Environment Settings \*\//);
    assert.deepStrictEqual(parse(file).exclude, ['node_modules', 'aws-blocks']);
  });

  it("appends to Next.js's existing exclude", () => {
    const file = write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { strict: true }, include: ['next-env.d.ts', '**/*.ts', '**/*.tsx'], exclude: ['node_modules'] }, null, 2),
    );
    assert.strictEqual(excludeBackendInTsconfig(file).status, 'updated');
    assert.deepStrictEqual(parse(file).exclude, ['node_modules', 'aws-blocks']);
  });

  it('inserts after the last entry when a comment follows it', () => {
    const file = write('tsconfig.json', `{\n  "include": ["**/*.ts"],\n  "exclude": [\n    "node_modules" // deps\n  ]\n}\n`);
    assert.strictEqual(excludeBackendInTsconfig(file).status, 'updated');
    assert.deepStrictEqual(parse(file).exclude, ['node_modules', 'aws-blocks']);
    assert.match(readFileSync(file, 'utf-8'), /\/\/ deps/);
  });

  it('inserts after the last property when a comment follows it', () => {
    const file = write('tsconfig.json', `{\n  "compilerOptions": { "strict": true } // options\n}\n`);
    assert.strictEqual(excludeBackendInTsconfig(file).status, 'updated');
    assert.deepStrictEqual(parse(file).exclude, ['node_modules', 'aws-blocks']);
    assert.match(readFileSync(file, 'utf-8'), /\/\/ options/);
  });

  it("keeps outDir excluded when replacing TypeScript's default exclude", () => {
    const file = write('tsconfig.json', JSON.stringify({ compilerOptions: { outDir: './dist' } }));
    assert.strictEqual(excludeBackendInTsconfig(file).status, 'updated');
    assert.deepStrictEqual(parse(file).exclude, ['node_modules', 'dist', 'aws-blocks']);
  });

  it('leaves a config alone when its include does not cover aws-blocks/ (Vite tsconfig.app.json)', () => {
    const original = JSON.stringify({ compilerOptions: { types: ['vite/client'] }, include: ['src'] });
    const file = write('tsconfig.app.json', original);
    assert.strictEqual(excludeBackendInTsconfig(file).status, 'unchanged');
    assert.strictEqual(readFileSync(file, 'utf-8'), original);
  });

  it('is idempotent', () => {
    const file = write('tsconfig.json', JSON.stringify({ include: ['**/*.ts'] }));
    assert.strictEqual(excludeBackendInTsconfig(file).status, 'updated');
    const once = readFileSync(file, 'utf-8');
    assert.strictEqual(excludeBackendInTsconfig(file).status, 'unchanged');
    assert.strictEqual(readFileSync(file, 'utf-8'), once);
  });

  it('reports a manual step instead of guessing on input it cannot scan', () => {
    const original = '{ "include": ["**/*.ts"], "exclude": ["node_modules" ';
    const file = write('tsconfig.json', original);
    assert.strictEqual(excludeBackendInTsconfig(file).status, 'manual');
    assert.strictEqual(readFileSync(file, 'utf-8'), original);
  });
});

describe('excludeBackendFromFrontendTsconfigs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tsconfig-exclude-refs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('follows a solution-style config into its references (Vite) and edits only those that cover aws-blocks/', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tools' }] }),
    );
    writeFileSync(join(dir, 'tsconfig.app.json'), JSON.stringify({ include: ['src'] }));
    mkdirSync(join(dir, 'tools'));
    writeFileSync(join(dir, 'tools', 'tsconfig.json'), JSON.stringify({ include: ['**/*'] }));

    const results = excludeBackendFromFrontendTsconfigs(dir);
    assert.deepStrictEqual(
      results.map((r) => [r.file.slice(dir.length + 1), r.status]),
      [
        ['tsconfig.json', 'unchanged'],
        ['tsconfig.app.json', 'unchanged'],
        [join('tools', 'tsconfig.json'), 'updated'],
      ],
    );
  });

  it('does nothing when the project has no tsconfig.json', () => {
    assert.deepStrictEqual(excludeBackendFromFrontendTsconfigs(dir), []);
  });
});
