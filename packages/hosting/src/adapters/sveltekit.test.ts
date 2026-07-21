// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// SvelteKit adapter — manifest-building logic exercised against a fabricated
// adapter-node `build/` tree with skipBuild, so no SvelteKit install or network
// is required.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  sveltekitAdapter,
  prerenderedDestRelPath,
  VERIFIED_SVELTEKIT_RANGE,
} from './sveltekit.js';

/**
 * Fabricate a `build/` tree shaped like `@sveltejs/adapter-node` output:
 *   build/index.js            — server entry
 *   build/client/_app/immutable/... — hashed assets
 *   build/client/favicon.png  — static asset
 *   build/prerendered/<page>  — prerendered HTML
 *   build/server/index.js     — SSR bundle
 * Also writes a package.json declaring @sveltejs/kit and materialises a fake
 * node_modules/@sveltejs/kit so the version guard passes.
 */
const scaffoldBuild = (
  projectDir: string,
  opts: {
    prerendered?: Record<string, string>; // relPath under prerendered/ -> html
    staticFiles?: string[]; // names under client/
    kitVersion?: string;
    base?: string;
    appDir?: string;
  } = {},
): void => {
  const {
    prerendered = {},
    staticFiles = ['favicon.png', 'robots.txt'],
    kitVersion = '2.15.0',
    base,
    appDir = '_app',
  } = opts;

  // package.json + fake installed @sveltejs/kit for the version guard.
  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'sk-fixture',
      devDependencies: { '@sveltejs/kit': `^${kitVersion}` },
      scripts: { build: 'vite build' },
    }),
  );
  const kitDir = path.join(projectDir, 'node_modules', '@sveltejs', 'kit');
  fs.mkdirSync(kitDir, { recursive: true });
  fs.writeFileSync(
    path.join(kitDir, 'package.json'),
    JSON.stringify({ name: '@sveltejs/kit', version: kitVersion }),
  );

  // svelte.config.js (references adapter-node so the bridge is skipped; also
  // carries base/appDir for the config-reader path).
  const kitBlock: string[] = [`adapter: adapter()`];
  if (appDir !== '_app') kitBlock.push(`appDir: '${appDir}'`);
  if (base !== undefined) kitBlock.push(`paths: { base: '${base}' }`);
  fs.writeFileSync(
    path.join(projectDir, 'svelte.config.js'),
    `import adapter from '@sveltejs/adapter-node';\n` +
      `export default { kit: { ${kitBlock.join(', ')} } };\n`,
  );

  const buildDir = path.join(projectDir, 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'index.js'), '// server entry');

  const immutable = path.join(buildDir, 'client', appDir, 'immutable');
  fs.mkdirSync(immutable, { recursive: true });
  fs.writeFileSync(path.join(immutable, 'chunk.abc123.js'), '//');

  for (const f of staticFiles) {
    fs.writeFileSync(path.join(buildDir, 'client', f), 'x');
  }

  const serverDir = path.join(buildDir, 'server');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'index.js'), '// ssr');

  if (Object.keys(prerendered).length > 0) {
    const prerenderedDir = path.join(buildDir, 'prerendered');
    for (const [rel, html] of Object.entries(prerendered)) {
      const dest = path.join(prerenderedDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, html);
    }
  }
};

void describe('sveltekitAdapter — manifest from build/ (skipBuild)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sveltekit-adapter-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  void it('produces an http-server compute pointing at run.sh with LWA env', () => {
    scaffoldBuild(tmp);
    const m = sveltekitAdapter({ projectDir: tmp, skipBuild: true });
    const c = m.compute.default;
    assert.equal(c.type, 'http-server');
    assert.equal(c.entrypoint, 'run.sh');
    assert.equal(c.port, 3000);
    assert.equal(c.placement, 'regional');
    assert.equal(c.bundle, path.join(tmp, 'build'));
    assert.equal(c.environment?.HOST_HEADER, 'x-forwarded-host');
    assert.equal(c.environment?.PROTOCOL_HEADER, 'x-forwarded-proto');
    assert.ok(
      Number(c.environment?.BODY_SIZE_LIMIT) > 512 * 1024,
      'BODY_SIZE_LIMIT should exceed adapter-node default 512KB',
    );
  });

  void it('writes a run.sh wrapper into build/ that execs node index.js', () => {
    scaffoldBuild(tmp);
    sveltekitAdapter({ projectDir: tmp, skipBuild: true });
    const runsh = fs.readFileSync(path.join(tmp, 'build', 'run.sh'), 'utf-8');
    assert.match(runsh, /node index\.js/);
  });

  void it('serves client/ as static with _app/immutable/* marked immutable', () => {
    scaffoldBuild(tmp);
    const m = sveltekitAdapter({ projectDir: tmp, skipBuild: true });
    assert.equal(m.staticAssets.directory, path.join(tmp, 'build', 'client'));
    assert.deepEqual(m.staticAssets.immutablePaths, ['_app/immutable/*']);
  });

  void it('routes /_app/*, top-level static entries, and a trailing /* → default', () => {
    scaffoldBuild(tmp, { staticFiles: ['favicon.png', 'robots.txt'] });
    const m = sveltekitAdapter({ projectDir: tmp, skipBuild: true });
    const patterns = m.routes.map((r) => r.pattern);
    assert.ok(patterns.includes('/_app/*'));
    assert.ok(patterns.includes('/favicon.png'));
    assert.ok(patterns.includes('/robots.txt'));
    // catch-all is last and targets compute.
    const last = m.routes[m.routes.length - 1];
    assert.equal(last.pattern, '/*');
    assert.equal(last.target, 'default');
    // _app route targets static.
    assert.equal(
      m.routes.find((r) => r.pattern === '/_app/*')?.target,
      'static',
    );
  });

  void it('emits bare + subtree static routes for prerendered pages and merges them into client/', () => {
    scaffoldBuild(tmp, {
      prerendered: {
        'about.html': '<h1>about</h1>',
        'blog/index.html': '<h1>blog</h1>',
      },
    });
    const m = sveltekitAdapter({ projectDir: tmp, skipBuild: true });
    const patterns = m.routes.map((r) => r.pattern);
    assert.ok(patterns.includes('/about'), 'bare /about');
    assert.ok(patterns.includes('/about/*'), '/about subtree');
    assert.ok(patterns.includes('/blog'), 'bare /blog (from index.html)');
    // Flat about.html is normalized into directory-index form so the L3
    // router's `/about` → `about/index.html` lookup resolves on S3.
    assert.ok(
      fs.existsSync(path.join(tmp, 'build', 'client', 'about', 'index.html')),
      'about.html normalized to about/index.html in client/',
    );
    // blog/index.html was already directory-index → copied as-is.
    assert.ok(
      fs.existsSync(path.join(tmp, 'build', 'client', 'blog', 'index.html')),
      'blog/index.html merged into client/',
    );
    // all prerendered routes are static (S3).
    for (const p of ['/about', '/blog']) {
      assert.equal(m.routes.find((r) => r.pattern === p)?.target, 'static', p);
    }
  });

  void it('wires errorPages when 404.html / 500.html are present in client/', () => {
    scaffoldBuild(tmp, { staticFiles: ['favicon.png'] });
    fs.writeFileSync(
      path.join(tmp, 'build', 'client', '404.html'),
      '<h1>404</h1>',
    );
    const m = sveltekitAdapter({ projectDir: tmp, skipBuild: true });
    assert.equal(m.errorPages?.[404], '/404.html');
  });

  void it('sets manifest.basePath from kit.paths.base', () => {
    scaffoldBuild(tmp, { base: '/app' });
    const m = sveltekitAdapter({ projectDir: tmp, skipBuild: true });
    assert.equal(m.basePath, '/app');
  });

  void it('honours a custom appDir for the immutable path + route', () => {
    scaffoldBuild(tmp, { appDir: '_sk' });
    const m = sveltekitAdapter({ projectDir: tmp, skipBuild: true });
    assert.deepEqual(m.staticAssets.immutablePaths, ['_sk/immutable/*']);
    assert.ok(m.routes.some((r) => r.pattern === '/_sk/*'));
  });

  void it('throws SvelteKitBuildOutputMissingError when build/index.js is absent', () => {
    scaffoldBuild(tmp);
    fs.rmSync(path.join(tmp, 'build', 'index.js'));
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp, skipBuild: true }),
      /SvelteKitBuildOutputMissingError/,
    );
  });

  void it('throws UnsupportedSvelteKitVersionError for SvelteKit < 2', () => {
    scaffoldBuild(tmp, { kitVersion: '1.30.0' });
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp, skipBuild: true }),
      /UnsupportedSvelteKitVersionError/,
    );
  });

  void it('throws UnsupportedSvelteKitVersionError for a SvelteKit major above the verified range', () => {
    // A new major (3.x) must be refused, not silently accepted — the verified
    // range caps below 3.0 until the adapter is re-verified against it.
    scaffoldBuild(tmp, { kitVersion: '3.0.0' });
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp, skipBuild: true }),
      /UnsupportedSvelteKitVersionError/,
    );
  });

  void it('serves a prerendered root (/) from S3 instead of the SSR catch-all', () => {
    scaffoldBuild(tmp, { prerendered: { 'index.html': '<h1>home</h1>' } });
    const m = sveltekitAdapter({ projectDir: tmp, skipBuild: true });
    const root = m.routes.find((r) => r.pattern === '/');
    assert.equal(root?.target, 'static', 'prerendered / routed to S3');
    // Catch-all is still last and still targets compute for deeper paths.
    const last = m.routes[m.routes.length - 1];
    assert.equal(last.pattern, '/*');
    assert.equal(last.target, 'default');
  });

  void it('does NOT emit a static / route when root is not prerendered', () => {
    scaffoldBuild(tmp);
    const m = sveltekitAdapter({ projectDir: tmp, skipBuild: true });
    assert.equal(
      m.routes.find((r) => r.pattern === '/'),
      undefined,
      'no bare / static route without a prerendered index.html',
    );
  });

  void it('routes a top-level static .html (terms.html) to S3, not the SSR Lambda', () => {
    scaffoldBuild(tmp, { staticFiles: ['favicon.png', 'terms.html'] });
    const m = sveltekitAdapter({ projectDir: tmp, skipBuild: true });
    assert.equal(
      m.routes.find((r) => r.pattern === '/terms.html')?.target,
      'static',
      'user static terms.html served from S3',
    );
  });

  void it('does NOT emit bare /index.html, /404.html, /500.html static routes', () => {
    scaffoldBuild(tmp, {
      staticFiles: ['favicon.png', 'index.html', '404.html', '500.html'],
    });
    const m = sveltekitAdapter({ projectDir: tmp, skipBuild: true });
    for (const p of ['/index.html', '/404.html', '/500.html']) {
      assert.equal(
        m.routes.find((r) => r.pattern === p),
        undefined,
        `${p} must not get a bare static route (handled by catch-all / errorPages)`,
      );
    }
  });

  void it('prunes adapter-node precompress siblings but keeps standalone user archives', () => {
    scaffoldBuild(tmp);
    const clientDir = path.join(tmp, 'build', 'client');
    // adapter-node precompress output: app.js + app.js.gz (has a sibling).
    fs.writeFileSync(path.join(clientDir, 'app.js'), 'x');
    fs.writeFileSync(path.join(clientDir, 'app.js.gz'), 'x');
    // A user's standalone archive under static/ (NO uncompressed sibling).
    fs.writeFileSync(path.join(clientDir, 'dataset.tar.gz'), 'x');
    fs.writeFileSync(path.join(clientDir, 'font.woff2.br'), 'x');

    sveltekitAdapter({ projectDir: tmp, skipBuild: true });

    assert.ok(
      !fs.existsSync(path.join(clientDir, 'app.js.gz')),
      'precompress sibling app.js.gz pruned',
    );
    assert.ok(
      fs.existsSync(path.join(clientDir, 'dataset.tar.gz')),
      'standalone dataset.tar.gz survives',
    );
    assert.ok(
      fs.existsSync(path.join(clientDir, 'font.woff2.br')),
      'standalone font.woff2.br survives',
    );
  });
});

void describe('sveltekitAdapter — bridge guards (build path)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sveltekit-bridge-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Minimal project (package.json + fake @sveltejs/kit + a svelte.config.js)
   * for exercising the pre-build bridge guards. `adapterImport` controls the
   * adapter the config references; omit it for a config with no adapter wired.
   */
  const scaffoldProject = (adapterImport?: string): void => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'sk-bridge-fixture',
        devDependencies: { '@sveltejs/kit': '^2.15.0' },
        scripts: { build: 'vite build' },
      }),
    );
    const kitDir = path.join(tmp, 'node_modules', '@sveltejs', 'kit');
    fs.mkdirSync(kitDir, { recursive: true });
    fs.writeFileSync(
      path.join(kitDir, 'package.json'),
      JSON.stringify({ name: '@sveltejs/kit', version: '2.15.0' }),
    );
    const importLine = adapterImport
      ? `import adapter from '${adapterImport}';\n`
      : '';
    const adapterField = adapterImport ? 'adapter: adapter()' : '';
    fs.writeFileSync(
      path.join(tmp, 'svelte.config.js'),
      `${importLine}export default { kit: { ${adapterField} } };\n`,
    );
  };

  void it('throws SvelteKitBridgeCollisionError before mutating anything when a stale backup exists', () => {
    // No adapter wired → the bridge path is taken. A leftover backup from a
    // crashed run must abort the deploy, NOT overwrite the user's real config.
    scaffoldProject();
    const backup = path.join(tmp, 'svelte.config.blocks-original.js');
    fs.writeFileSync(backup, '// user real config parked by a prior crash\n');
    const configBefore = fs.readFileSync(
      path.join(tmp, 'svelte.config.js'),
      'utf-8',
    );
    const backupBefore = fs.readFileSync(backup, 'utf-8');

    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp }),
      /SvelteKitBridgeCollisionError/,
    );

    // Nothing was touched: the active config and the backup are byte-identical.
    assert.equal(
      fs.readFileSync(path.join(tmp, 'svelte.config.js'), 'utf-8'),
      configBefore,
      'svelte.config.js untouched',
    );
    assert.equal(fs.readFileSync(backup, 'utf-8'), backupBefore, 'backup untouched');
  });

  void it('throws SvelteKitIncompatibleAdapterError for a non-adapter-node adapter', () => {
    // A deliberately-wired incompatible adapter must fail loudly rather than be
    // silently swapped for adapter-node.
    scaffoldProject('@sveltejs/adapter-cloudflare');
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp }),
      /SvelteKitIncompatibleAdapterError/,
    );
  });

  void it('is not fooled by a commented-out adapter-node import with an active incompatible adapter', () => {
    // A stale adapter-node comment must NOT make the guard think adapter-node is
    // wired; the active adapter-cloudflare import must still be rejected.
    scaffoldProject();
    fs.writeFileSync(
      path.join(tmp, 'svelte.config.js'),
      `// import node from '@sveltejs/adapter-node'; // old — switched to cloudflare\n` +
        `import cloudflare from '@sveltejs/adapter-cloudflare';\n` +
        `export default { kit: { adapter: cloudflare() } };\n`,
    );
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp }),
      /SvelteKitIncompatibleAdapterError/,
    );
  });

  void it('does NOT throw when the only adapter reference is a commented-out incompatible adapter', () => {
    // Inverse: a commented adapter with none active should not spuriously error.
    // Config has no active adapter → bridge path installs adapter-node; stub the
    // install by pre-providing a resolvable adapter-node so no network is hit.
    scaffoldProject();
    fs.writeFileSync(
      path.join(tmp, 'svelte.config.js'),
      `// import cloudflare from '@sveltejs/adapter-cloudflare';\n` +
        `export default { kit: {} };\n`,
    );
    // Pre-provide adapter-node so installAdapterNode's version-aware skip fires
    // and no package manager is spawned; the build itself is what we avoid by
    // asserting only that the incompatible-adapter guard does not throw.
    const anDir = path.join(tmp, 'node_modules', '@sveltejs', 'adapter-node');
    fs.mkdirSync(anDir, { recursive: true });
    fs.writeFileSync(
      path.join(anDir, 'package.json'),
      JSON.stringify({ name: '@sveltejs/adapter-node', version: '5.2.0' }),
    );
    // The build will still run (and fail, since there's no real toolchain), but
    // it must NOT be the incompatible-adapter error.
    try {
      sveltekitAdapter({ projectDir: tmp });
    } catch (err) {
      assert.doesNotMatch(
        (err as Error).name + (err as Error).message,
        /SvelteKitIncompatibleAdapterError/,
        'must not raise the incompatible-adapter error for a commented reference',
      );
    }
  });

  void it('detects a stale backup left under a different extension (.js backup, .mjs config)', () => {
    // Crash under a `.js` config left svelte.config.blocks-original.js; user has
    // since migrated to svelte.config.mjs. The guard must still catch the stale
    // backup rather than proceeding and orphaning it.
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'sk-bridge-fixture',
        devDependencies: { '@sveltejs/kit': '^2.15.0' },
        scripts: { build: 'vite build' },
      }),
    );
    const kitDir = path.join(tmp, 'node_modules', '@sveltejs', 'kit');
    fs.mkdirSync(kitDir, { recursive: true });
    fs.writeFileSync(
      path.join(kitDir, 'package.json'),
      JSON.stringify({ name: '@sveltejs/kit', version: '2.15.0' }),
    );
    // Active config is .mjs (no adapter → bridge path); stale backup is .js.
    fs.writeFileSync(
      path.join(tmp, 'svelte.config.mjs'),
      `export default { kit: {} };\n`,
    );
    fs.writeFileSync(
      path.join(tmp, 'svelte.config.blocks-original.js'),
      '// stale backup from a prior crash under .js\n',
    );
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp }),
      /SvelteKitBridgeCollisionError/,
    );
  });
});

void describe('prerenderedDestRelPath — flat → directory-index normalization', () => {
  void it('converts a flat page to directory-index form', () => {
    assert.equal(prerenderedDestRelPath('about.html'), 'about/index.html');
    assert.equal(
      prerenderedDestRelPath('blog/post.html'),
      'blog/post/index.html',
    );
  });
  void it('leaves root index, already-index, error pages, and assets unchanged', () => {
    assert.equal(prerenderedDestRelPath('index.html'), 'index.html');
    assert.equal(
      prerenderedDestRelPath('blog/index.html'),
      'blog/index.html',
    );
    assert.equal(prerenderedDestRelPath('404.html'), '404.html');
    assert.equal(prerenderedDestRelPath('500.html'), '500.html');
    assert.equal(
      prerenderedDestRelPath('data/feed.json'),
      'data/feed.json',
    );
  });
});

void describe('sveltekitAdapter — version pin', () => {
  void it('exports a bounded verified range', () => {
    assert.match(VERIFIED_SVELTEKIT_RANGE, /</);
  });
});
