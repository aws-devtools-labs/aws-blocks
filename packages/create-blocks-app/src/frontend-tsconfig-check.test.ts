import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFrontendTsconfig, checkFrontendTsconfigs } from './frontend-tsconfig-check.js';

describe('checkFrontendTsconfig', () => {
  let dir: string;
  const write = (name: string, value: unknown) => {
    const file = join(dir, name);
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return file;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'frontend-tsconfig-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a Next.js config, whose **/*.ts roots the backend', () => {
    const file = write('tsconfig.json', { include: ['next-env.d.ts', '**/*.ts', '**/*.tsx'], exclude: ['node_modules'] });
    assert.deepStrictEqual(checkFrontendTsconfig(file), { file, kind: 'covers-backend' });
  });

  it('reports a `tsc --init` config, which has no include and so roots everything', () => {
    const file = write('tsconfig.json', { compilerOptions: { strict: true } });
    assert.deepStrictEqual(checkFrontendTsconfig(file), { file, kind: 'covers-backend' });
  });

  it('says nothing about a Vite app config, whose include is just src', () => {
    const file = write('tsconfig.app.json', { compilerOptions: { types: ['vite/client'] }, include: ['src'] });
    assert.strictEqual(checkFrontendTsconfig(file), undefined);
  });

  it('says nothing when aws-blocks is already excluded, whatever include says', () => {
    const file = write('tsconfig.json', { include: ['**/*.ts'], exclude: ['node_modules', 'aws-blocks'] });
    assert.strictEqual(checkFrontendTsconfig(file), undefined);
  });

  it('says nothing when `files` limits the program instead of include', () => {
    const file = write('tsconfig.json', { files: ['src/main.ts'] });
    assert.strictEqual(checkFrontendTsconfig(file), undefined);
  });

  it('reports extends separately, because the base config is not visible', () => {
    const file = write('tsconfig.json', { extends: './tsconfig.base.json', compilerOptions: { strict: true } });
    assert.deepStrictEqual(checkFrontendTsconfig(file), { file, kind: 'unknown-extends' });
  });

  it('reads JSONC — comments and trailing commas are not errors', () => {
    const file = write('tsconfig.json', `{\n  // a comment\n  "include": ["src"],\n}\n`);
    assert.strictEqual(checkFrontendTsconfig(file), undefined);
  });

  it('reports a config it cannot parse rather than assuming either way', () => {
    const file = write('tsconfig.json', '{ "include": ["src" ');
    assert.deepStrictEqual(checkFrontendTsconfig(file), { file, kind: 'unreadable' });
  });

  it('never writes to the file it checks', () => {
    const original = JSON.stringify({ include: ['**/*.ts'] }, null, 2);
    const file = write('tsconfig.json', original);
    checkFrontendTsconfig(file);
    assert.strictEqual(readFileSync(file, 'utf-8'), original);
  });
});

describe('checkFrontendTsconfigs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'frontend-tsconfigs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('follows a solution-style config into its references and reports only the covering ones', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tools' }] }),
    );
    writeFileSync(join(dir, 'tsconfig.app.json'), JSON.stringify({ include: ['src'] }));
    mkdirSync(join(dir, 'tools'));
    writeFileSync(join(dir, 'tools', 'tsconfig.json'), JSON.stringify({ include: ['**/*'] }));

    assert.deepStrictEqual(
      checkFrontendTsconfigs(dir).map((f) => [f.file.slice(dir.length + 1), f.kind]),
      [[join('tools', 'tsconfig.json'), 'covers-backend']],
    );
  });

  it('returns nothing when the project has no tsconfig.json', () => {
    assert.deepStrictEqual(checkFrontendTsconfigs(dir), []);
  });
});
