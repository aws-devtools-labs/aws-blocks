import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spaAdapter } from './spa.js';
import { getAdapter } from './index.js';
import { deployManifestSchema } from '../manifest/schema.js';

void describe('spaAdapter', () => {
  let tmpDir: string;
  let buildDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-spa-test-'));
    buildDir = path.join(tmpDir, 'dist');

    // Create a mock build output
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(buildDir, 'main.js'), 'console.log("app")');
    fs.mkdirSync(path.join(buildDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(buildDir, 'assets', 'style.css'), 'body{}');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('produces correct manifest with catch-all static route', () => {
    const manifest = spaAdapter(tmpDir);

    assert.strictEqual(manifest.version, 1);
    assert.strictEqual(manifest.routes.length, 1);
    assert.strictEqual(manifest.routes[0].pattern, '/*');
    assert.strictEqual(manifest.routes[0].target, 'static');
    assert.deepStrictEqual(manifest.compute, {});
  });

  // ── spaFallback comes from the framework contract, NOT filesystem sniffing ──
  // Sniffing misclassified both a SPA shipping a nested index.html and a
  // flat-file SSG. The routing model is now declared by the `framework`
  // string via getAdapter: 'spa' → true, 'static' → false.

  void it('framework "spa" → spaFallback:true (single-page contract)', () => {
    const adapter = getAdapter('spa');
    const manifest = adapter(tmpDir);
    assert.strictEqual(manifest.staticAssets.spaFallback, true);
  });

  void it('framework "static" → spaFallback:false (multi-page contract)', () => {
    const adapter = getAdapter('static');
    const manifest = adapter(tmpDir);
    assert.strictEqual(manifest.staticAssets.spaFallback, false);
  });

  void it('SPA shipping a nested index.html STAYS spaFallback:true (no misclassification)', () => {
    // Scenario: a real SPA with a nested static page (e.g. public/legal/
    // index.html). Old sniffing flipped this to false and broke client-side
    // deep-linking. The framework contract keeps it true.
    fs.mkdirSync(path.join(buildDir, 'legal'), { recursive: true });
    fs.writeFileSync(path.join(buildDir, 'legal', 'index.html'), '<html></html>');
    const manifest = getAdapter('spa')(tmpDir);
    assert.strictEqual(manifest.staticAssets.spaFallback, true);
  });

  void it('flat-file SSG (about.html, no nested index) → spaFallback:false (no misclassification)', () => {
    // Scenario: a flat-file SSG (Astro build.format 'file', Hugo uglyURLs)
    // emits about.html, not about/index.html. Old sniffing found no nested
    // index.html and wrongly chose SPA fallback — the exact bug this change
    // fixes. The framework contract keeps it false.
    fs.writeFileSync(path.join(buildDir, 'about.html'), '<html>about</html>');
    const manifest = getAdapter('static')(tmpDir);
    assert.strictEqual(manifest.staticAssets.spaFallback, false);
  });

  void it('default (no framework signal, direct spaAdapter) → spaFallback:true', () => {
    // Back-compat: a caller invoking spaAdapter directly without declaring a
    // model keeps the historical SPA behavior.
    const manifest = spaAdapter(tmpDir);
    assert.strictEqual(manifest.staticAssets.spaFallback, true);
  });

  void it('copies files to .hosting/static/', () => {
    spaAdapter(tmpDir);

    const staticDir = path.join(tmpDir, '.hosting', 'static');
    assert.ok(fs.existsSync(path.join(staticDir, 'index.html')));
    assert.ok(fs.existsSync(path.join(staticDir, 'main.js')));
    assert.ok(fs.existsSync(path.join(staticDir, 'assets', 'style.css')));
  });

  void it('returns manifest without writing to disk', () => {
    const manifest = spaAdapter(tmpDir);

    const manifestPath = path.join(
      tmpDir,
      '.hosting',
      'deploy-manifest.json',
    );
    assert.ok(
      !fs.existsSync(manifestPath),
      'Manifest should not be written to disk',
    );
    assert.strictEqual(manifest.version, 1);
    assert.strictEqual(manifest.routes[0].pattern, '/*');
    assert.strictEqual(manifest.routes[0].target, 'static');
  });

  void it('cleans previous hosting output before copying', () => {
    spaAdapter(tmpDir);

    // Add a file that shouldn't survive
    const staleFile = path.join(
      tmpDir,
      '.hosting',
      'static',
      'stale.txt',
    );
    fs.writeFileSync(staleFile, 'stale');

    spaAdapter(tmpDir);
    assert.ok(
      !fs.existsSync(staleFile),
      'Stale files should be cleaned on re-run',
    );
  });

  void it('throws when build output directory does not exist', () => {
    const emptyProject = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hosting-spa-empty-'),
    );
    assert.throws(
      () => spaAdapter(emptyProject),
      (error: Error) => {
        assert.ok(error.name === 'BuildOutputNotFoundError');
        return true;
      },
    );
    fs.rmSync(emptyProject, { recursive: true, force: true });
  });

  void it('excludes source map files by default', () => {
    fs.writeFileSync(path.join(buildDir, 'main.js.map'), '{"sourcemap":true}');
    fs.writeFileSync(path.join(buildDir, 'assets', 'style.css.map'), '{}');

    spaAdapter(tmpDir);

    const staticDir = path.join(tmpDir, '.hosting', 'static');
    assert.ok(
      !fs.existsSync(path.join(staticDir, 'main.js.map')),
      'Source maps should be excluded from static output',
    );
    assert.ok(
      !fs.existsSync(path.join(staticDir, 'assets', 'style.css.map')),
      'Nested source maps should be excluded',
    );
    assert.ok(
      fs.existsSync(path.join(staticDir, 'main.js')),
      'Non-map files should be copied',
    );
  });

  void it('excludes .DS_Store and thumbs.db', () => {
    fs.writeFileSync(path.join(buildDir, '.DS_Store'), '');
    fs.writeFileSync(path.join(buildDir, 'thumbs.db'), '');

    spaAdapter(tmpDir);

    const staticDir = path.join(tmpDir, '.hosting', 'static');
    assert.ok(
      !fs.existsSync(path.join(staticDir, '.DS_Store')),
      '.DS_Store should be excluded',
    );
    assert.ok(
      !fs.existsSync(path.join(staticDir, 'thumbs.db')),
      'thumbs.db should be excluded',
    );
  });

  void it('throws BuildOutputEmptyError for empty build directory', () => {
    const emptyProject = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hosting-spa-empty-build-'),
    );
    const emptyDist = path.join(emptyProject, 'dist');
    fs.mkdirSync(emptyDist, { recursive: true });

    assert.throws(
      () => spaAdapter(emptyProject),
      (error: Error) => {
        assert.strictEqual(error.name, 'BuildOutputEmptyError');
        return true;
      },
    );
    fs.rmSync(emptyProject, { recursive: true, force: true });
  });

  void it('throws MissingIndexHtmlError when no index.html is found', () => {
    fs.unlinkSync(path.join(buildDir, 'index.html'));

    assert.throws(
      () => spaAdapter(tmpDir),
      (error: Error) => {
        assert.strictEqual(error.name, 'MissingIndexHtmlError');
        return true;
      },
    );
  });

  void it('adapter output passes schema validation', () => {
    const manifest = spaAdapter(tmpDir);
    const result = deployManifestSchema.safeParse(manifest);
    assert.ok(
      result.success,
      `Schema validation failed: ${JSON.stringify(result.error?.issues)}`,
    );
  });

  void it('uses explicit buildOutputDir when provided', () => {
    const customOut = path.join(tmpDir, 'custom-output');
    fs.mkdirSync(customOut, { recursive: true });
    fs.writeFileSync(path.join(customOut, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(customOut, 'app.js'), 'app()');

    const manifest = spaAdapter(tmpDir, { buildOutputDir: 'custom-output' });

    assert.strictEqual(manifest.version, 1);
    assert.strictEqual(manifest.routes[0].target, 'static');
    const staticDir = path.join(tmpDir, '.hosting', 'static');
    assert.ok(fs.existsSync(path.join(staticDir, 'app.js')));
  });

  void it('detects 404.html and 500.html as error pages', () => {
    fs.writeFileSync(path.join(buildDir, '404.html'), '<html>Not Found</html>');
    fs.writeFileSync(
      path.join(buildDir, '500.html'),
      '<html>Server Error</html>',
    );

    const manifest = spaAdapter(tmpDir);

    assert.ok(manifest.errorPages);
    assert.strictEqual(manifest.errorPages![404], '/404.html');
    assert.strictEqual(manifest.errorPages![500], '/500.html');
  });

  void it('skips symlinked files during copy', () => {
    // Create a symlink in the build directory
    const realFile = path.join(tmpDir, 'real-target.txt');
    fs.writeFileSync(realFile, 'real content');
    fs.symlinkSync(realFile, path.join(buildDir, 'linked-file.txt'));

    const manifest = spaAdapter(tmpDir);

    const staticDir = path.join(tmpDir, '.hosting', 'static');
    assert.ok(
      !fs.existsSync(path.join(staticDir, 'linked-file.txt')),
      'Symlinked files should be excluded from static output',
    );
    assert.strictEqual(manifest.version, 1);
  });
});
