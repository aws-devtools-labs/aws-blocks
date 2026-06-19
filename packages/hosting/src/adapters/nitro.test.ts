import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from './spawn.js';
import { nitroAdapter } from './nitro.js';

/**
 * Build a minimal `.output/` layout that nitroAdapter accepts. Caller
 * passes any extra files / overrides via `extras`.
 */
const writeMinimalNitroOutput = (
  projectDir: string,
  extras: {
    /** Contents of `.output/nitro.json`; omit for "no nitro.json". */
    nitroJson?: Record<string, unknown>;
    /**
     * Contents of `.output/server/chunks/nitro/nitro.mjs` (used to harvest
     *  bundled routeRules). Default: empty server bundle (no rules).
     */
    bundledRouteRules?: Record<string, unknown>;
    /**
     * `app.baseURL` baked into the server bundle's runtime config (as Nitro
     * does). Omit for the default (no base path). Set e.g. `'/myapp/'` to
     * exercise the basePath extraction.
     */
    baseURL?: string;
    /**
     * Relative path → contents for files written under `.output/public/`.
     * Used to exercise the prerendered-HTML baseURL safety net.
     */
    publicFiles?: Record<string, string>;
  } = {},
): void => {
  const outputDir = path.join(projectDir, '.output');
  const serverDir = path.join(outputDir, 'server');
  const publicDir = path.join(outputDir, 'public');
  const chunksDir = path.join(serverDir, 'chunks', 'nitro');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(chunksDir, { recursive: true });
  // Server entry — content doesn't matter, only existence.
  fs.writeFileSync(
    path.join(serverDir, 'index.mjs'),
    'export const handler = async () => {};',
  );
  // Bundled route rules — adapter scans this with a regex looking for
  // `"routeRules":` followed by a JSON object. The `baseURL` (when set) is
  // embedded the same way Nitro bakes it into the runtime config blob.
  const bundledRules = extras.bundledRouteRules ?? {};
  const baseURLBlob =
    extras.baseURL !== undefined
      ? ` "baseURL": ${JSON.stringify(extras.baseURL)},`
      : '';
  const bundleSource = `// nitro server bundle\n_inlineRuntimeConfig = { app: {${baseURLBlob} }, nitro: { "routeRules": ${JSON.stringify(bundledRules)} } };\n`;
  fs.writeFileSync(path.join(chunksDir, 'nitro.mjs'), bundleSource);
  // Optional prerendered HTML / public files.
  for (const [rel, content] of Object.entries(extras.publicFiles ?? {})) {
    const dest = path.join(publicDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  // nitro.json — optional but commonly present.
  if (extras.nitroJson) {
    fs.writeFileSync(
      path.join(outputDir, 'nitro.json'),
      JSON.stringify(extras.nitroJson),
    );
  }
};

const writePackageJson = (
  projectDir: string,
  deps: Record<string, string> = {},
): void => {
  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: deps }),
  );
  // The nitro adapter probes installed packages (via local-pkg) for
  // @nuxt/image — synthesise the matching node_modules/<pkg>/ stubs
  // so the existing fixtures stay representative of "deps installed".
  for (const [name, spec] of Object.entries(deps)) {
    const numericMatch =
      typeof spec === 'string' ? spec.match(/(\d+)\.(\d+)\.(\d+)/) : null;
    const version = numericMatch
      ? `${numericMatch[1]}.${numericMatch[2]}.${numericMatch[3]}`
      : '1.0.0';
    const pkgDir = path.join(projectDir, 'node_modules', ...name.split('/'));
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name, version, main: 'index.js' }),
    );
    fs.writeFileSync(path.join(pkgDir, 'index.js'), '');
  }
};

const writeNuxtConfig = (projectDir: string, source: string): void => {
  fs.writeFileSync(path.join(projectDir, 'nuxt.config.ts'), source);
};

void describe('nitroAdapter — cache provisioning', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nitro-cache-'));
    mock.method(spawn, 'sync', () => undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  void it('does NOT provision cache for vanilla Nuxt (only framework-default cache: false rules)', () => {
    // Mirrors what real Nuxt 4 emits for a project with no user route
    // rules: just the built-in `__nuxt_error: { cache: false }`.
    writeMinimalNitroOutput(tmpDir, {
      bundledRouteRules: {
        '/__nuxt_error': { cache: false },
      },
    });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });

    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(
      manifest.cache,
      undefined,
      'cache: false is the framework default and must not trigger cache provisioning',
    );
  });

  void it('provisions cache when user sets swr: <number>', () => {
    writeMinimalNitroOutput(tmpDir, {
      bundledRouteRules: {
        '/__nuxt_error': { cache: false },
        '/news': { swr: 60 },
      },
    });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });

    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.ok(manifest.cache, 'truthy swr must trigger cache provisioning');
    assert.strictEqual(manifest.cache.driver, 'nitro-s3');
    assert.strictEqual(manifest.cache.computeResource, 'default');
  });

  void it('does NOT provision cache when swr: 0 (falsy override)', () => {
    writeMinimalNitroOutput(tmpDir, {
      bundledRouteRules: {
        '/news': { swr: 0 },
      },
    });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });

    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(manifest.cache, undefined);
  });

  void it('provisions cache when user sets isr: true', () => {
    writeMinimalNitroOutput(tmpDir, {
      bundledRouteRules: {
        '/blog/**': { isr: true },
      },
    });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });

    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.ok(manifest.cache);
    assert.strictEqual(manifest.cache.driver, 'nitro-s3');
  });
});

void describe('nitroAdapter — IPX provisioning', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nitro-ipx-'));
    mock.method(spawn, 'sync', () => undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  void it('provisions IPX Lambda when @nuxt/image is in deps and config is default', () => {
    writeMinimalNitroOutput(tmpDir);
    writePackageJson(tmpDir, {
      nuxt: '^4.0.0',
      '@nuxt/image': '^2.0.0',
    });

    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.ok(
      manifest.imageOptimization,
      'IPX Lambda should be provisioned when @nuxt/image is present',
    );
    assert.strictEqual(manifest.imageOptimization.baseURL, '/_ipx');
    assert.strictEqual(
      manifest.imageOptimization.environment,
      undefined,
      'IPX_BASE_URL env var should be omitted when using the default path',
    );
    // Route at the default IPX path should be present.
    const ipxRoute = manifest.routes.find(
      (r) => r.target === 'image-optimization',
    );
    assert.ok(ipxRoute, 'a route targeting image-optimization must exist');
    assert.strictEqual(ipxRoute.pattern, '/_ipx/*');
  });

  void it('does NOT provision IPX Lambda when @nuxt/image is missing', () => {
    writeMinimalNitroOutput(tmpDir);
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });

    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(manifest.imageOptimization, undefined);
    const ipxRoute = manifest.routes.find(
      (r) => r.target === 'image-optimization',
    );
    assert.strictEqual(ipxRoute, undefined);
  });

  void it('does NOT provision IPX Lambda when @nuxt/image is declared but never installed (no node_modules)', () => {
    writeMinimalNitroOutput(tmpDir);
    // Manually write package.json *without* the writePackageJson helper
    // so node_modules/@nuxt/image is NOT created — this is the bug
    // local-pkg fixes (declared deps that were never `npm install`-ed
    // would have shipped a dangling 50 MB IPX Lambda).
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        dependencies: { nuxt: '^4.0.0', '@nuxt/image': '^2.0.0' },
      }),
    );
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(
      manifest.imageOptimization,
      undefined,
      'image-opt Lambda must NOT be provisioned for declared-but-not-installed @nuxt/image',
    );
  });

  void it('does NOT provision IPX Lambda when image: false', () => {
    writeMinimalNitroOutput(tmpDir);
    writePackageJson(tmpDir, {
      nuxt: '^4.0.0',
      '@nuxt/image': '^2.0.0',
    });
    writeNuxtConfig(
      tmpDir,
      `export default defineNuxtConfig({ image: false });`,
    );

    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(
      manifest.imageOptimization,
      undefined,
      'image: false must skip the IPX Lambda even if @nuxt/image is in deps',
    );
  });

  void it("does NOT provision IPX Lambda when image: { provider: 'none' }", () => {
    writeMinimalNitroOutput(tmpDir);
    writePackageJson(tmpDir, {
      nuxt: '^4.0.0',
      '@nuxt/image': '^2.0.0',
    });
    writeNuxtConfig(
      tmpDir,
      `export default defineNuxtConfig({
         image: { provider: 'none' },
       });`,
    );

    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(manifest.imageOptimization, undefined);
  });

  void it("does NOT provision IPX Lambda when provider is a third-party CDN (e.g. 'cloudinary')", () => {
    writeMinimalNitroOutput(tmpDir);
    writePackageJson(tmpDir, {
      nuxt: '^4.0.0',
      '@nuxt/image': '^2.0.0',
    });
    writeNuxtConfig(
      tmpDir,
      `export default defineNuxtConfig({
         image: { provider: 'cloudinary', cloudinary: { baseURL: '...' } },
       });`,
    );

    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(
      manifest.imageOptimization,
      undefined,
      'non-IPX providers route to the third-party CDN; the Lambda is dead code',
    );
  });

  void it("provisions IPX Lambda when provider is 'ipx' explicitly", () => {
    writeMinimalNitroOutput(tmpDir);
    writePackageJson(tmpDir, {
      nuxt: '^4.0.0',
      '@nuxt/image': '^2.0.0',
    });
    writeNuxtConfig(
      tmpDir,
      `export default defineNuxtConfig({
         image: { provider: 'ipx' },
       });`,
    );

    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.ok(manifest.imageOptimization);
  });

  void it("provisions IPX Lambda when provider is 'ipxStatic'", () => {
    writeMinimalNitroOutput(tmpDir);
    writePackageJson(tmpDir, {
      nuxt: '^4.0.0',
      '@nuxt/image': '^2.0.0',
    });
    writeNuxtConfig(
      tmpDir,
      `export default defineNuxtConfig({
         image: { provider: 'ipxStatic' },
       });`,
    );

    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.ok(manifest.imageOptimization);
  });
});

void describe('nitroAdapter — IPX baseURL plumbing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nitro-baseurl-'));
    mock.method(spawn, 'sync', () => undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  void it('respects user-configured runtimeConfig.ipx.baseURL', () => {
    writeMinimalNitroOutput(tmpDir);
    writePackageJson(tmpDir, {
      nuxt: '^4.0.0',
      '@nuxt/image': '^2.0.0',
    });
    writeNuxtConfig(
      tmpDir,
      `export default defineNuxtConfig({
         runtimeConfig: { ipx: { baseURL: '/img-cdn' } },
       });`,
    );

    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.ok(manifest.imageOptimization);
    assert.strictEqual(manifest.imageOptimization.baseURL, '/img-cdn');
    assert.deepStrictEqual(
      manifest.imageOptimization.environment,
      { IPX_BASE_URL: '/img-cdn' },
      'custom baseURL must be passed to the Lambda via IPX_BASE_URL env var',
    );
    // Route pattern reflects the configured path.
    const ipxRoute = manifest.routes.find(
      (r) => r.target === 'image-optimization',
    );
    assert.ok(ipxRoute);
    assert.strictEqual(ipxRoute.pattern, '/img-cdn/*');
  });

  void it('handles trailing slash on user baseURL', () => {
    writeMinimalNitroOutput(tmpDir);
    writePackageJson(tmpDir, {
      nuxt: '^4.0.0',
      '@nuxt/image': '^2.0.0',
    });
    writeNuxtConfig(
      tmpDir,
      `export default defineNuxtConfig({
         runtimeConfig: { ipx: { baseURL: '/img-cdn/' } },
       });`,
    );

    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    // Note: the regex captures up to the closing quote, so trailing slash
    // is preserved in `baseURL` itself; the route-pattern build trims it
    // before appending /*.
    assert.strictEqual(manifest.imageOptimization?.baseURL, '/img-cdn/');
    const ipxRoute = manifest.routes.find(
      (r) => r.target === 'image-optimization',
    );
    assert.strictEqual(
      ipxRoute?.pattern,
      '/img-cdn/*',
      'trailing slash on baseURL must not double-up in the route pattern',
    );
  });

  void it('falls back to /_ipx when nuxt.config has no runtimeConfig.ipx.baseURL', () => {
    writeMinimalNitroOutput(tmpDir);
    writePackageJson(tmpDir, {
      nuxt: '^4.0.0',
      '@nuxt/image': '^2.0.0',
    });
    writeNuxtConfig(
      tmpDir,
      `export default defineNuxtConfig({
         runtimeConfig: { someOtherKey: 'whatever' },
       });`,
    );

    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(manifest.imageOptimization?.baseURL, '/_ipx');
    assert.strictEqual(
      manifest.imageOptimization?.environment,
      undefined,
      'environment override should be omitted for the default path',
    );
  });
});

void describe('nitroAdapter — preset + feature validation', () => {
  let tmpDir: string;
  let stderrChunks: string[];
  let restoreStderr: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nitro-validate-'));
    mock.method(spawn, 'sync', () => undefined);
    stderrChunks = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    restoreStderr = () => {
      process.stderr.write = original;
    };
  });

  afterEach(() => {
    restoreStderr?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  void it('throws UnsupportedNitroPresetError on unsupported preset (cloudflare)', () => {
    writeMinimalNitroOutput(tmpDir, { nitroJson: { preset: 'cloudflare' } });
    writePackageJson(tmpDir);
    assert.throws(() => nitroAdapter({ projectDir: tmpDir, skipBuild: true }), {
      code: 'UnsupportedNitroPresetError',
    });
  });

  void it('accepts aws-lambda', () => {
    writeMinimalNitroOutput(tmpDir, { nitroJson: { preset: 'aws-lambda' } });
    writePackageJson(tmpDir);
    assert.doesNotThrow(() =>
      nitroAdapter({ projectDir: tmpDir, skipBuild: true }),
    );
  });

  void it('accepts aws-lambda-streaming', () => {
    writeMinimalNitroOutput(tmpDir, {
      nitroJson: { preset: 'aws-lambda-streaming' },
    });
    writePackageJson(tmpDir);
    assert.doesNotThrow(() =>
      nitroAdapter({ projectDir: tmpDir, skipBuild: true }),
    );
  });

  void it('accepts node-server', () => {
    writeMinimalNitroOutput(tmpDir, { nitroJson: { preset: 'node-server' } });
    writePackageJson(tmpDir);
    assert.doesNotThrow(() =>
      nitroAdapter({ projectDir: tmpDir, skipBuild: true }),
    );
  });

  void it('warns (does not throw) on experimental.websocket: true (Nitro 2.x key)', () => {
    writeMinimalNitroOutput(tmpDir, {
      nitroJson: {
        preset: 'aws-lambda',
        config: { experimental: { websocket: true } },
      },
    });
    writePackageJson(tmpDir);
    assert.doesNotThrow(() =>
      nitroAdapter({ projectDir: tmpDir, skipBuild: true }),
    );
    assert.ok(
      stderrChunks.join('').includes('WebSocket'),
      'must warn about unsupported WebSocket',
    );
  });

  void it('warns (does not throw) on features.websocket: true (Nitro 3 key)', () => {
    // Nitro 3 / the `nitro` package renamed the flag from
    // experimental.websocket to features.websocket; the warning must catch
    // both or a v3 WS app silently deploys and 200s on upgrade with no notice.
    writeMinimalNitroOutput(tmpDir, {
      nitroJson: {
        preset: 'aws-lambda',
        config: { features: { websocket: true } },
      },
    });
    writePackageJson(tmpDir);
    assert.doesNotThrow(() =>
      nitroAdapter({ projectDir: tmpDir, skipBuild: true }),
    );
    assert.ok(
      stderrChunks.join('').includes('WebSocket'),
      'must warn about unsupported WebSocket (Nitro 3 key)',
    );
  });

  void it('warns (does not throw) on non-empty scheduledTasks', () => {
    writeMinimalNitroOutput(tmpDir, {
      nitroJson: {
        preset: 'aws-lambda',
        config: { scheduledTasks: { '* * * * *': ['cleanup'] } },
      },
    });
    writePackageJson(tmpDir);
    assert.doesNotThrow(() =>
      nitroAdapter({ projectDir: tmpDir, skipBuild: true }),
    );
    assert.ok(
      stderrChunks.join('').includes('scheduledTasks'),
      'must warn that scheduledTasks never fire',
    );
  });

  void it('does not warn when scheduledTasks is an empty object', () => {
    writeMinimalNitroOutput(tmpDir, {
      nitroJson: {
        preset: 'aws-lambda',
        config: { scheduledTasks: {} },
      },
    });
    writePackageJson(tmpDir);
    assert.doesNotThrow(() =>
      nitroAdapter({ projectDir: tmpDir, skipBuild: true }),
    );
    assert.strictEqual(
      stderrChunks.join('').includes('scheduledTasks'),
      false,
      'empty scheduledTasks must not warn',
    );
  });
});

void describe('nitroAdapter — output dir resolution from nitro.json', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nitro-outputs-'));
    mock.method(spawn, 'sync', () => undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  void it('honors output.serverDir / output.publicDir from nitro.json', () => {
    // Lay down the default `.output/` skeleton so the writeMinimalNitroOutput
    // helper still applies, then add Nitro-reported custom paths.
    const customServer = path.join(tmpDir, '.output', 'server');
    const customPublic = path.join(tmpDir, '.output', 'public');
    fs.mkdirSync(customServer, { recursive: true });
    fs.mkdirSync(customPublic, { recursive: true });
    fs.writeFileSync(
      path.join(customServer, 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.output', 'nitro.json'),
      JSON.stringify({
        preset: 'aws-lambda',
        // Absolute paths simulate a future Nitro that resolves dirs to
        // absolute form before writing the JSON.
        output: { serverDir: customServer, publicDir: customPublic },
      }),
    );
    writePackageJson(tmpDir);
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(manifest.staticAssets.directory, customPublic);
  });

  void it('falls back to .output/server and .output/public when nitro.json omits output paths', () => {
    writeMinimalNitroOutput(tmpDir, {
      nitroJson: { preset: 'aws-lambda' },
    });
    writePackageJson(tmpDir);
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(
      manifest.staticAssets.directory,
      path.join(tmpDir, '.output', 'public'),
    );
  });
});

void describe('nitroAdapter — materializeNitroDepStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nitro-prune-'));
    mock.method(spawn, 'sync', () => undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  void it('removes node_modules/.nitro before manifest emission while preserving symlinked deps', () => {
    writeMinimalNitroOutput(tmpDir);
    writePackageJson(tmpDir);
    // Synthesize Nitro's pnpm-style isolated dep store with one cyclic
    // symlink pair (a → b → a). On macOS (and any FS that resolves
    // symlinks during scandir) walking this cycle exhausts PATH_MAX —
    // we have to remove the store before CDK can hash it.
    const serverDir = path.join(tmpDir, '.output', 'server');
    const nm = path.join(serverDir, 'node_modules');
    const nitroStore = path.join(nm, '.nitro');
    fs.mkdirSync(nitroStore, { recursive: true });
    const aDir = path.join(nitroStore, 'a@1.0.0');
    const bDir = path.join(nitroStore, 'b@1.0.0');
    fs.mkdirSync(aDir);
    fs.mkdirSync(bDir);
    fs.symlinkSync(bDir, path.join(aDir, 'cycle'));
    fs.symlinkSync(aDir, path.join(bDir, 'cycle'));
    // Add a real package symlink under node_modules/<pkg>/ → .nitro/<pkg>@<ver>/
    // Real pkg has a runtime file the Lambda would load.
    const pkgRealDir = path.join(nitroStore, 'mypkg@1.2.3');
    fs.mkdirSync(pkgRealDir);
    fs.writeFileSync(path.join(pkgRealDir, 'index.js'), 'module.exports = 42;');
    fs.symlinkSync(pkgRealDir, path.join(nm, 'mypkg'));

    nitroAdapter({ projectDir: tmpDir, skipBuild: true });

    assert.strictEqual(
      fs.existsSync(nitroStore),
      false,
      'node_modules/.nitro must be removed before the asset hasher runs',
    );
    // Regression: the symlink at node_modules/<pkg>/ must be materialised
    // into a real directory containing the package contents — pre-fix this
    // was left dangling and CDK dropped it from the Lambda zip, causing
    // `Cannot find module` crashes on init.
    const materialisedPkg = path.join(nm, 'mypkg');
    assert.strictEqual(
      fs.existsSync(materialisedPkg),
      true,
      'symlinked dep must remain reachable after .nitro/ removal',
    );
    assert.strictEqual(
      fs.lstatSync(materialisedPkg).isDirectory(),
      true,
      'symlinked dep must be materialised into a real directory',
    );
    assert.strictEqual(
      fs.readFileSync(path.join(materialisedPkg, 'index.js'), 'utf-8'),
      'module.exports = 42;',
      'materialised dep must contain the original file contents',
    );
  });

  void it('is a no-op when there is no node_modules/.nitro directory', () => {
    writeMinimalNitroOutput(tmpDir);
    writePackageJson(tmpDir);
    assert.doesNotThrow(() =>
      nitroAdapter({ projectDir: tmpDir, skipBuild: true }),
    );
  });
});

void describe('nitroAdapter — _hosting-cache.mjs collision protection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nitro-collision-'));
    mock.method(spawn, 'sync', () => undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  void it('throws NitroCachePluginCollisionError when user already has _hosting-cache.mjs', () => {
    writePackageJson(tmpDir);
    const pluginsDir = path.join(tmpDir, 'server', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, '_hosting-cache.mjs'),
      '// user-authored',
    );
    assert.throws(
      () =>
        nitroAdapter({
          projectDir: tmpDir,
          // skipBuild: false would normally fire the build; keep the same
          // path so installNitroCachePlugin runs.
          skipBuild: false,
        }),
      { code: 'NitroCachePluginCollisionError' },
    );
    // Original user file preserved (collision check must run before the
    // overwrite).
    assert.strictEqual(
      fs.readFileSync(path.join(pluginsDir, '_hosting-cache.mjs'), 'utf-8'),
      '// user-authored',
    );
  });
});

void describe('nitroAdapter — routeRules header lift (cors, cache.maxAge)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nitro-headers-'));
    mock.method(spawn, 'sync', () => undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  void it('lifts cors: true to standard Access-Control-* headers', () => {
    writeMinimalNitroOutput(tmpDir, {
      bundledRouteRules: { '/api/public/**': { cors: true } },
    });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    const lifted = manifest.headers?.find((h) => h.source === '/api/public/*');
    assert.ok(lifted, 'cors: true should produce a manifest.headers entry');
    assert.strictEqual(lifted!.headers['Access-Control-Allow-Origin'], '*');
    assert.match(
      lifted!.headers['Access-Control-Allow-Methods'],
      /\bGET\b.*\bPOST\b.*\bDELETE\b.*\bOPTIONS\b/,
    );
    assert.match(
      lifted!.headers['Access-Control-Allow-Headers'],
      /\bContent-Type\b.*\bAuthorization\b/,
    );
  });

  void it('does NOT lift cors: false (default behavior — no headers)', () => {
    writeMinimalNitroOutput(tmpDir, {
      bundledRouteRules: { '/api/private/**': { cors: false } },
    });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(manifest.headers, undefined);
  });

  void it('lifts cache.maxAge to Cache-Control with both max-age and s-maxage', () => {
    writeMinimalNitroOutput(tmpDir, {
      bundledRouteRules: { '/news/**': { cache: { maxAge: 60 } } },
    });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    const lifted = manifest.headers?.find((h) => h.source === '/news/*');
    assert.ok(lifted, 'cache.maxAge should produce a manifest.headers entry');
    assert.strictEqual(
      lifted!.headers['Cache-Control'],
      'public, max-age=60, s-maxage=60',
    );
  });

  void it('does NOT lift cache.swr without a maxAge (no freshness window to express)', () => {
    writeMinimalNitroOutput(tmpDir, {
      bundledRouteRules: { '/news/**': { cache: { swr: true } } },
    });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    // swr:true alone (no maxAge) has no freshness window to encode → no header.
    assert.strictEqual(
      manifest.headers,
      undefined,
      'swr without maxAge should not auto-emit Cache-Control',
    );
  });

  void it('lifts SWR (cache.swr + maxAge) to s-maxage + stale-while-revalidate, no max-age', () => {
    writeMinimalNitroOutput(tmpDir, {
      bundledRouteRules: { '/news/**': { cache: { swr: true, maxAge: 30 } } },
    });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    const lifted = manifest.headers?.find((h) => h.source === '/news/*');
    assert.ok(lifted, 'SWR should produce a manifest.headers entry');
    const cc = lifted!.headers['Cache-Control'];
    // SWR semantics: edge fresh for maxAge, then serve stale while
    // revalidating. NO max-age (browsers must revalidate).
    assert.match(cc, /\bs-maxage=30\b/);
    assert.match(cc, /\bstale-while-revalidate=\d+\b/);
    assert.doesNotMatch(cc, /\bmax-age=/, 'SWR must not emit max-age');
  });

  void it('lifts the swr: <number> shorthand to SWR Cache-Control', () => {
    // Nitro accepts `swr: 30` as shorthand; the adapter treats the untyped
    // top-level `swr` flag as SWR intent when a maxAge is present.
    writeMinimalNitroOutput(tmpDir, {
      bundledRouteRules: {
        '/feed/**': { swr: true, cache: { maxAge: 45 } },
      } as never,
    });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    const lifted = manifest.headers?.find((h) => h.source === '/feed/*');
    assert.ok(lifted);
    const cc = lifted!.headers['Cache-Control'];
    assert.match(cc, /\bs-maxage=45\b/);
    assert.match(cc, /\bstale-while-revalidate=\d+\b/);
    assert.doesNotMatch(cc, /\bmax-age=/);
  });

  void it('user-declared headers win over auto-emitted CORS / Cache-Control', () => {
    writeMinimalNitroOutput(tmpDir, {
      bundledRouteRules: {
        '/api/**': {
          cors: true,
          cache: { maxAge: 30 },
          // eslint-disable-next-line @typescript-eslint/naming-convention
          headers: {
            'Access-Control-Allow-Origin': 'https://example.com',
            'Cache-Control': 'public, max-age=300',
          },
        },
      },
    });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    const lifted = manifest.headers!.find((h) => h.source === '/api/*');
    assert.ok(lifted);
    // User wins on overlapping headers...
    assert.strictEqual(
      lifted!.headers['Access-Control-Allow-Origin'],
      'https://example.com',
    );
    assert.strictEqual(lifted!.headers['Cache-Control'], 'public, max-age=300');
    // ...but auto-emitted headers the user didn't specify still apply.
    assert.match(
      lifted!.headers['Access-Control-Allow-Methods'],
      /POST/,
      'Allow-Methods should fall through to auto-emit when user did not set it',
    );
  });

  void it('merges multiple sources independently', () => {
    writeMinimalNitroOutput(tmpDir, {
      bundledRouteRules: {
        '/api/public/**': { cors: true },
        '/news/**': { cache: { maxAge: 60 } },
      },
    });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    const sources = manifest.headers?.map((h) => h.source).sort();
    assert.deepStrictEqual(sources, ['/api/public/*', '/news/*']);
  });
});

void describe('nitroAdapter — app.baseURL → manifest.basePath (P0.1)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nitro-baseurl-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('extracts a non-root baseURL from the server bundle and normalizes it', () => {
    writeMinimalNitroOutput(tmpDir, { baseURL: '/myapp/' });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    // Normalized: leading slash, no trailing slash.
    assert.strictEqual(manifest.basePath, '/myapp');
  });

  void it('leaves basePath undefined for the default baseURL "/"', () => {
    writeMinimalNitroOutput(tmpDir, { baseURL: '/' });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(manifest.basePath, undefined);
  });

  void it('leaves basePath undefined when no baseURL is present', () => {
    writeMinimalNitroOutput(tmpDir);
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(manifest.basePath, undefined);
  });

  void it('fails loud when prerendered HTML reveals a baseURL the bundle scan missed', () => {
    // Bundle has no baseURL (simulating a future Nitro shape change), but the
    // prerendered HTML clearly references `/myapp/_nuxt/...` assets — dropping
    // the prefix would 404 every hashed asset, so synth must fail.
    writeMinimalNitroOutput(tmpDir, {
      publicFiles: {
        'about/index.html':
          '<html><head><script src="/myapp/_nuxt/abc.js"></script></head></html>',
      },
    });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });
    assert.throws(
      () => nitroAdapter({ projectDir: tmpDir, skipBuild: true }),
      (e: Error) => {
        assert.strictEqual(e.name, 'NuxtBaseURLDetectionError');
        return true;
      },
    );
  });

  void it('does NOT fail when prerendered HTML uses the default root asset path', () => {
    writeMinimalNitroOutput(tmpDir, {
      publicFiles: {
        'about/index.html':
          '<html><head><script src="/_nuxt/abc.js"></script></head></html>',
      },
    });
    writePackageJson(tmpDir, { nuxt: '^4.0.0' });
    const manifest = nitroAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(manifest.basePath, undefined);
  });
});
