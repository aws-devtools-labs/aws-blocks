import { describe, it } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';

import { PLACEHOLDER, blocksDepNames, takePlaceholderBlocksDeps } from './blocks-deps.js';

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

describe('takePlaceholderBlocksDeps', () => {
  it('removes the placeholders and returns them, so npm can install them by name', () => {
    const pkg = {
      dependencies: { '@aws-blocks/blocks': '*', '@aws-blocks/hosting': '*', 'lit-html': '^3.3.3' },
    };
    assert.deepStrictEqual(takePlaceholderBlocksDeps(pkg), ['@aws-blocks/blocks', '@aws-blocks/hosting']);
    assert.deepStrictEqual(pkg.dependencies, { 'lit-html': '^3.3.3' });
  });

  it('leaves a range the project already declared, and does not install over it', () => {
    const pkg = { dependencies: { '@aws-blocks/blocks': '~0.8.0', '@aws-blocks/hosting': '*' } };
    assert.deepStrictEqual(takePlaceholderBlocksDeps(pkg), ['@aws-blocks/hosting']);
    assert.deepStrictEqual(pkg.dependencies, { '@aws-blocks/blocks': '~0.8.0' });
  });

  it('is a no-op for a manifest with no placeholders', () => {
    const pkg = { dependencies: { 'lit-html': '^3.3.3' } };
    assert.deepStrictEqual(takePlaceholderBlocksDeps(pkg), []);
    assert.deepStrictEqual(pkg.dependencies, { 'lit-html': '^3.3.3' });
    assert.deepStrictEqual(takePlaceholderBlocksDeps({}), []);
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
    it(`declares its blocks dependencies as the placeholder in ${label}`, () => {
      const pkg = JSON.parse(readFileSync(path, 'utf-8'));
      for (const name of blocksDepNames(pkg)) {
        assert.strictEqual(
          pkg.dependencies[name],
          PLACEHOLDER,
          `${label} declares ${name} as ${pkg.dependencies[name]}; templates must ship the placeholder so the CLI installs the package by name`,
        );
      }
    });

    it(`leaves no @aws-blocks/* range behind for npm to resolve in ${label}`, () => {
      const pkg = JSON.parse(readFileSync(path, 'utf-8'));
      const taken = takePlaceholderBlocksDeps(pkg);
      assert.deepStrictEqual(
        blocksDepNames(pkg),
        [],
        `${label} still declares ${blocksDepNames(pkg).join(', ')} after the placeholders were taken`,
      );
      if (taken.length > 0) assert.ok(taken.every((n: string) => n.startsWith('@aws-blocks/')));
    });
  }
});
