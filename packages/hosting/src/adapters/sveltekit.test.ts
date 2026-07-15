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
