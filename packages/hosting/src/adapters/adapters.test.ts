import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  detectFramework,
  getAdapter,
  readProjectDeps,
  readProjectDepsStrict,
} from './index.js';

/**
 * Write a `package.json` to the given directory with the provided
 * dependencies and/or devDependencies.
 */
const writePackageJson = (
  projectDir: string,
  pkg: {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  },
): void => {
  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: 'test-project', ...pkg }),
  );
};

/**
 * Materialise a fake `node_modules/<name>/package.json` so the package
 * appears installed via Node's module resolution — but NOT necessarily
 * declared in the project's own `package.json`.
 *
 * Used to simulate transitive / peer dep installations that should NOT
 * trigger framework detection.
 */
const installFakePackage = (
  projectDir: string,
  name: string,
  version = '1.0.0',
): void => {
  const pkgDir = path.join(projectDir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name, version, main: 'index.js' }),
  );
  fs.writeFileSync(path.join(pkgDir, 'index.js'), '');
};

void describe('detectFramework', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-detect-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('detects nextjs when next is in dependencies', () => {
    writePackageJson(tmpDir, { dependencies: { next: '^14.0.0' } });
    assert.strictEqual(detectFramework(tmpDir), 'nextjs');
  });

  void it('detects nextjs when next is in devDependencies', () => {
    writePackageJson(tmpDir, { devDependencies: { next: '^14.0.0' } });
    assert.strictEqual(detectFramework(tmpDir), 'nextjs');
  });

  void it('returns spa for Vite/React project without next in package.json', () => {
    writePackageJson(tmpDir, {
      dependencies: { react: '^18.0.0', vite: '^5.0.0' },
    });
    assert.strictEqual(detectFramework(tmpDir), 'spa');
  });

  void it('returns spa when next is installed in node_modules (peer dep) but NOT in project deps — regression #833', () => {
    // This is the KEY regression test: next is resolvable from
    // node_modules (e.g. installed as a peer dep of @aws-blocks/core)
    // but the project's own package.json does NOT list it.
    writePackageJson(tmpDir, {
      dependencies: { react: '^18.0.0', vite: '^5.0.0' },
    });
    installFakePackage(tmpDir, 'next', '14.0.0');
    assert.strictEqual(detectFramework(tmpDir), 'spa');
  });

  void it('returns spa when no package.json exists', () => {
    assert.strictEqual(detectFramework(tmpDir), 'spa');
  });

  void it('returns spa for project with empty dependencies', () => {
    writePackageJson(tmpDir, { dependencies: {} });
    assert.strictEqual(detectFramework(tmpDir), 'spa');
  });

  void it('returns spa when package.json is corrupted', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ invalid json !!!');
    assert.strictEqual(detectFramework(tmpDir), 'spa');
  });

  void it('detects astro when astro is in dependencies', () => {
    writePackageJson(tmpDir, { dependencies: { astro: '^5.0.0' } });
    assert.strictEqual(detectFramework(tmpDir), 'astro');
  });

  void it('returns spa when astro is in node_modules but NOT in project deps', () => {
    writePackageJson(tmpDir, { dependencies: { react: '^18.0.0' } });
    installFakePackage(tmpDir, 'astro', '5.0.0');
    assert.strictEqual(detectFramework(tmpDir), 'spa');
  });

  void it('detects sveltekit when @sveltejs/kit is in devDependencies', () => {
    writePackageJson(tmpDir, {
      devDependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^5.0.0' },
    });
    assert.strictEqual(detectFramework(tmpDir), 'sveltekit');
  });

  void it('returns spa for a plain Svelte + Vite SPA (svelte without @sveltejs/kit)', () => {
    writePackageJson(tmpDir, {
      devDependencies: { svelte: '^5.0.0', vite: '^5.0.0' },
    });
    assert.strictEqual(detectFramework(tmpDir), 'spa');
  });

  void it('returns spa when @sveltejs/kit is in node_modules but NOT in project deps', () => {
    writePackageJson(tmpDir, { dependencies: { react: '^18.0.0' } });
    installFakePackage(tmpDir, '@sveltejs/kit', '2.0.0');
    assert.strictEqual(detectFramework(tmpDir), 'spa');
  });

  void it('prefers nitro over astro when both are in deps', () => {
    writePackageJson(tmpDir, {
      dependencies: { astro: '^5.0.0', nitropack: '^2.0.0' },
    });
    assert.strictEqual(detectFramework(tmpDir), 'nitro');
  });

  void it('detects nitro from nuxt / @solidjs/start / @analogjs/platform-server / @tanstack/start', () => {
    for (const pkg of [
      'nuxt',
      '@solidjs/start',
      '@analogjs/platform-server',
      '@tanstack/start',
    ]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nitro-'));
      try {
        writePackageJson(dir, { dependencies: { [pkg]: '^1.0.0' } });
        assert.strictEqual(detectFramework(dir), 'nitro', `pkg=${pkg}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  void it('detects nuxt as nitro when nuxt is in node_modules AND in project deps', () => {
    writePackageJson(tmpDir, { dependencies: { nuxt: '^3.0.0' } });
    installFakePackage(tmpDir, 'nuxt', '3.0.0');
    assert.strictEqual(detectFramework(tmpDir), 'nitro');
  });
});

void describe('readProjectDeps', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-deps-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('returns {} when package.json is missing', () => {
    assert.deepStrictEqual(readProjectDeps(tmpDir), {});
  });

  void it('returns {} when package.json is unparseable', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ broken');
    assert.deepStrictEqual(readProjectDeps(tmpDir), {});
  });

  void it('reads dependencies', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { foo: '^1.0.0' } }),
    );
    assert.deepStrictEqual(readProjectDeps(tmpDir), { foo: '^1.0.0' });
  });

  void it('reads devDependencies', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { typescript: '^5.0.0' } }),
    );
    assert.deepStrictEqual(readProjectDeps(tmpDir), { typescript: '^5.0.0' });
  });

  void it('reads peerDependencies', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ peerDependencies: { react: '^18.0.0' } }),
    );
    assert.deepStrictEqual(readProjectDeps(tmpDir), { react: '^18.0.0' });
  });

  void it('merges all three with peer > dev > deps precedence', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { foo: '1.0.0', shared: '1.0.0' },
        devDependencies: { bar: '1.0.0', shared: '2.0.0' },
        peerDependencies: { baz: '1.0.0', shared: '3.0.0' },
      }),
    );
    assert.deepStrictEqual(readProjectDeps(tmpDir), {
      foo: '1.0.0',
      bar: '1.0.0',
      baz: '1.0.0',
      shared: '3.0.0',
    });
  });

  void it('readProjectDepsStrict returns {} when missing but throws on parse error', () => {
    assert.deepStrictEqual(readProjectDepsStrict(tmpDir), {});
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ broken');
    assert.throws(
      () => readProjectDepsStrict(tmpDir),
      (error: Error) => {
        assert.strictEqual(error.name, 'PackageJsonParseError');
        return true;
      },
    );
  });
});

void describe('getAdapter', () => {
  void it('returns spa adapter for "spa" framework', () => {
    const adapter = getAdapter('spa');
    assert.ok(typeof adapter === 'function');
  });

  void it('returns spa adapter for "static" framework', () => {
    const adapter = getAdapter('static');
    assert.ok(typeof adapter === 'function');
  });

  void it('returns nextjs adapter for "nextjs" framework', () => {
    const adapter = getAdapter('nextjs');
    assert.ok(typeof adapter === 'function');
  });

  void it('throws UnsupportedFrameworkError for unknown framework', () => {
    assert.throws(
      () => getAdapter('unknown-framework-xyz'),
      (error: Error) => {
        assert.strictEqual(error.name, 'UnsupportedFrameworkError');
        assert.ok(error.message.includes('unknown-framework-xyz'));
        return true;
      },
    );
  });
});
