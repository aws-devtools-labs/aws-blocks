import { describe, it } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';

import { applyBlocksRanges, blocksDepNames, resolveBlocksRanges } from './blocks-deps.js';

// Compiled test runs from dist/; templates live at the package root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '../templates');

describe('blocksDepNames', () => {
  it('returns the @aws-blocks/* dependencies and nothing else', () => {
    const pkg = {
      dependencies: { '@aws-blocks/blocks': '*', '@aws-blocks/hosting': '*', 'lit-html': '^3.3.3' },
      devDependencies: { '@aws-blocks/bb-kv-store': '*', typescript: '^5.9.3' },
    };
    assert.deepStrictEqual(blocksDepNames(pkg), ['@aws-blocks/blocks', '@aws-blocks/hosting']);
  });

  it('returns an empty list when the manifest declares no blocks dependencies', () => {
    assert.deepStrictEqual(blocksDepNames({ dependencies: { 'lit-html': '^3.3.3' } }), []);
    assert.deepStrictEqual(blocksDepNames({}), []);
  });
});

describe('resolveBlocksRanges', () => {
  it('records the resolved release as a caret range', async () => {
    const ranges = await resolveBlocksRanges(['@aws-blocks/blocks', '@aws-blocks/hosting'], async (name) =>
      name === '@aws-blocks/blocks' ? '0.9.0' : '0.5.1',
    );
    assert.deepStrictEqual(ranges, { '@aws-blocks/blocks': '^0.9.0', '@aws-blocks/hosting': '^0.5.1' });
  });

  it('fails naming the package when the registry cannot be reached', async () => {
    await assert.rejects(
      () => resolveBlocksRanges(['@aws-blocks/blocks'], async () => { throw new Error('ENOTFOUND registry.npmjs.org'); }),
      /@aws-blocks\/blocks/,
    );
  });

  it('fails naming the package when the registry answers with something that is not a version', async () => {
    await assert.rejects(
      () => resolveBlocksRanges(['@aws-blocks/blocks'], async () => 'not-a-version'),
      /@aws-blocks\/blocks/,
    );
  });
});

describe('applyBlocksRanges', () => {
  it('replaces the placeholder and leaves every other dependency untouched', () => {
    const pkg = {
      dependencies: { '@aws-blocks/blocks': '*', 'lit-html': '^3.3.3' },
    };
    applyBlocksRanges(pkg, { '@aws-blocks/blocks': '^0.9.0' });
    assert.deepStrictEqual(pkg.dependencies, { '@aws-blocks/blocks': '^0.9.0', 'lit-html': '^3.3.3' });
  });

  it('keeps a range the project already declared', () => {
    const pkg = { dependencies: { '@aws-blocks/blocks': '~0.8.0' } };
    applyBlocksRanges(pkg, { '@aws-blocks/blocks': '^0.9.0' });
    assert.strictEqual(pkg.dependencies['@aws-blocks/blocks'], '~0.8.0');
  });
});

describe('every template', () => {
  const templates = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  // Every manifest a template ships, including nested workspaces (the Amplify
  // template keeps its blocks dependencies in templates/amplify/aws-blocks).
  const manifests = templates.flatMap((name) => {
    const found: { label: string; path: string }[] = [];
    for (const rel of ['package.json', 'aws-blocks/package.json']) {
      const path = join(TEMPLATES_DIR, name, rel);
      try {
        readFileSync(path, 'utf-8');
        found.push({ label: `${name}/${rel}`, path });
      } catch {
        // Not every template has a nested workspace.
      }
    }
    return found;
  });

  it('is covered by this test', () => {
    assert.ok(manifests.length >= 10, `expected every template manifest, found ${manifests.length}`);
  });

  for (const { label, path } of manifests) {
    it(`leaves no unresolved @aws-blocks/* range in ${label}`, async () => {
      const pkg = JSON.parse(readFileSync(path, 'utf-8'));
      const names = blocksDepNames(pkg);
      if (names.length === 0) return;

      const ranges = await resolveBlocksRanges(names, async () => '0.9.0');
      applyBlocksRanges(pkg, ranges);

      for (const name of names) {
        assert.strictEqual(
          pkg.dependencies[name],
          '^0.9.0',
          `${label} still declares ${name} as ${pkg.dependencies[name]}`,
        );
      }
    });
  }
});
