// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// SvelteKit adapter — the server function ships build/ without node_modules,
// so the build bundles the server's dependencies and synth refuses a server
// that still imports a package build/ can't resolve.

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from './spawn.js';
import {
  sveltekitAdapter,
  bareServerImports,
  buildViteBridgeSource,
  SVELTEKIT_BUNDLE_PLUGIN_NAME,
} from './sveltekit.js';

/** A project with SvelteKit 2 + adapter-node "installed" and an adapter-node `build/` tree. */
const scaffold = (dir: string, opts: { adapterWired?: boolean; viteConfig?: string } = {}): void => {
  const { adapterWired = true, viteConfig } = opts;
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'sk-deps-fixture',
      type: 'module',
      dependencies: { '@aws-blocks/blocks': '*' },
      devDependencies: { '@sveltejs/kit': '^2.15.0', '@sveltejs/adapter-node': '^5.2.0' },
      scripts: { build: 'vite build' },
    }),
  );
  for (const [name, version] of [
    ['kit', '2.15.0'],
    ['adapter-node', '5.2.0'],
  ] as const) {
    const pkgDir = path.join(dir, 'node_modules', '@sveltejs', name);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: `@sveltejs/${name}`, version }));
  }
  fs.writeFileSync(
    path.join(dir, 'svelte.config.js'),
    adapterWired
      ? `import adapter from '@sveltejs/adapter-node';\nexport default { kit: { adapter: adapter() } };\n`
      : `export default { kit: {} };\n`,
  );
  if (viteConfig !== undefined) fs.writeFileSync(path.join(dir, 'vite.config.ts'), viteConfig);
  const buildDir = path.join(dir, 'build');
  fs.mkdirSync(path.join(buildDir, 'client', '_app', 'immutable'), { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'client', '_app', 'immutable', 'chunk.abc.js'), '//');
  fs.mkdirSync(path.join(buildDir, 'server', 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'index.js'), "import { handler } from './handler.js';\nimport http from 'node:http';\n");
  fs.writeFileSync(path.join(buildDir, 'server', 'index.js'), "import 'fs';\nexport const x = 'y';\n");
};

/** Write a server chunk the way adapter-node leaves a package from `dependencies`: a bare import. */
const writeServerChunk = (dir: string, source: string): void => {
  fs.writeFileSync(path.join(dir, 'build', 'server', 'chunks', '_page.server.ts.js'), source);
};

const VITE_CONFIG = `import { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({ plugins: [sveltekit()] });\n`;

void describe('sveltekitAdapter — server dependencies in build/', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sveltekit-deps-'));
  });
  afterEach(() => {
    mock.restoreAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  void it('fails synth when the server imports a package build/ cannot resolve', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import { withAuth } from '@aws-blocks/blocks/server';\nexport const load = withAuth;\n");
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp, skipBuild: true }),
      (err: Error) =>
        err.name === 'SvelteKitUnbundledDependencyError' &&
        err.message.includes('@aws-blocks/blocks (imported from build/server/chunks/_page.server.ts.js)'),
    );
  });

  void it('names a dynamic import and a re-export too', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "export { a } from 'devalue';\nconst m = () => import('cookie');\n");
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp, skipBuild: true }),
      (err: Error) => err.message.includes('devalue') && err.message.includes('cookie'),
    );
  });

  void it('deploys a server that imports only built-ins and its own files', () => {
    scaffold(tmp);
    writeServerChunk(
      tmp,
      "import { a } from '../index.js';\nimport { readFile } from 'node:fs/promises';\nimport path from 'path';\nexport const s = 'import x from \"left-pad\"';\n",
    );
    const manifest = sveltekitAdapter({ projectDir: tmp, skipBuild: true });
    assert.equal(manifest.compute.default?.bundle, path.join(tmp, 'build'));
  });

  void it('ignores type references in comments, as bundled adapter-node and SvelteKit code keeps them', () => {
    scaffold(tmp);
    writeServerChunk(
      tmp,
      [
        "/** @returns {import('polka').Middleware} */",
        'function a() {}',
        '/**',
        " * @param {import('cookie').CookieParseOptions} [opts]",
        ' */',
        "    // `@type {import('@sveltejs/kit').Cookies}` above is not",
        "const url = 'https://example.com/x'; // import('left-pad')",
        '',
      ].join('\n'),
    );
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
  });

  void it('deploys a server whose dependency is shipped under build/node_modules', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import { withAuth } from '@aws-blocks/blocks/server';\n");
    const shipped = path.join(tmp, 'build', 'node_modules', '@aws-blocks', 'blocks');
    fs.mkdirSync(shipped, { recursive: true });
    fs.writeFileSync(path.join(shipped, 'package.json'), '{}');
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
  });

  for (const adapterWired of [true, false]) {
    void it(`builds through the Vite bundling bridge and restores vite.config.ts (${adapterWired ? 'app wires adapter-node' : 'transparent bridge'})`, () => {
      scaffold(tmp, { adapterWired, viteConfig: VITE_CONFIG });
      const viteConfigPath = path.join(tmp, 'vite.config.ts');
      let duringBuild = '';
      let backupDuringBuild = '';
      mock.method(spawn, 'sync', () => {
        duringBuild = fs.readFileSync(viteConfigPath, 'utf-8');
        backupDuringBuild = fs.readFileSync(path.join(tmp, 'vite.config.blocks-original.ts'), 'utf-8');
      });
      sveltekitAdapter({ projectDir: tmp });
      assert.match(duringBuild, /import userConfig from '\.\/vite\.config\.blocks-original\.ts';/);
      assert.ok(duringBuild.includes(SVELTEKIT_BUNDLE_PLUGIN_NAME), 'the bundling plugin is in the build config');
      assert.equal(backupDuringBuild, VITE_CONFIG, 'the original is parked unchanged');
      assert.equal(fs.readFileSync(viteConfigPath, 'utf-8'), VITE_CONFIG, 'vite.config.ts is restored');
      assert.ok(!fs.existsSync(path.join(tmp, 'vite.config.blocks-original.ts')), 'no backup left');
    });
  }

  void it('restores vite.config.ts when the build fails', () => {
    scaffold(tmp, { viteConfig: VITE_CONFIG });
    mock.method(spawn, 'sync', () => {
      throw new Error('vite build failed');
    });
    assert.throws(() => sveltekitAdapter({ projectDir: tmp }), /SvelteKitBuildError/);
    assert.equal(fs.readFileSync(path.join(tmp, 'vite.config.ts'), 'utf-8'), VITE_CONFIG);
    assert.ok(!fs.existsSync(path.join(tmp, 'vite.config.blocks-original.ts')));
  });

  void it('refuses a leftover Vite bridge backup before touching anything', () => {
    scaffold(tmp, { viteConfig: VITE_CONFIG });
    const backup = path.join(tmp, 'vite.config.blocks-original.mjs');
    fs.writeFileSync(backup, '// parked by a crashed run\n');
    let built = false;
    mock.method(spawn, 'sync', () => {
      built = true;
    });
    assert.throws(() => sveltekitAdapter({ projectDir: tmp }), /SvelteKitBridgeCollisionError/);
    assert.equal(built, false);
    assert.equal(fs.readFileSync(path.join(tmp, 'vite.config.ts'), 'utf-8'), VITE_CONFIG);
    assert.equal(fs.readFileSync(backup, 'utf-8'), '// parked by a crashed run\n');
  });
});

void describe('buildViteBridgeSource', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sveltekit-vite-bridge-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  type Plugin = { name: string; apply?: string; config?: () => unknown };
  type ViteConfig = { plugins?: Plugin[]; ssr?: unknown; base?: string };

  const loadBridge = async (original: string): Promise<(env: unknown) => Promise<ViteConfig>> => {
    fs.writeFileSync(path.join(tmp, 'original.mjs'), original);
    fs.writeFileSync(path.join(tmp, 'bridge.mjs'), buildViteBridgeSource('original.mjs'));
    const mod = (await import(pathToFileURL(path.join(tmp, 'bridge.mjs')).href)) as {
      default: (env: unknown) => Promise<ViteConfig>;
    };
    return mod.default;
  };

  for (const [label, original] of [
    ['an object', "export default { base: '/x', plugins: [{ name: 'user' }], ssr: { external: ['sharp'] } };\n"],
    ['a function of the config env', "export default (env) => ({ base: env.mode === 'production' ? '/x' : '/', plugins: [{ name: 'user' }], ssr: { external: ['sharp'] } });\n"],
    ['a promise', "export default Promise.resolve({ base: '/x', plugins: [{ name: 'user' }], ssr: { external: ['sharp'] } });\n"],
  ] as const) {
    void it(`keeps the app's config (${label}) and appends a build-only plugin that sets ssr.noExternal`, async () => {
      const bridge = await loadBridge(original);
      const config = await bridge({ command: 'build', mode: 'production' });
      assert.equal(config.base, '/x');
      assert.deepEqual(config.ssr, { external: ['sharp'] });
      assert.deepEqual(config.plugins?.map((p) => p.name), ['user', SVELTEKIT_BUNDLE_PLUGIN_NAME]);
      const plugin = config.plugins?.[1];
      assert.equal(plugin?.apply, 'build');
      assert.deepEqual(plugin?.config?.(), { ssr: { noExternal: true } });
    });
  }

  void it('works for a config without plugins', async () => {
    const bridge = await loadBridge('export default {};\n');
    const config = await bridge({ command: 'build', mode: 'production' });
    assert.deepEqual(config.plugins?.map((p) => p.name), [SVELTEKIT_BUNDLE_PLUGIN_NAME]);
  });
});

void describe('bareServerImports', () => {
  void it('skips client assets, prerendered pages and node_modules', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sveltekit-bare-'));
    try {
      for (const rel of ['client/_app/a.js', 'prerendered/b.js', 'node_modules/x/index.js']) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), "import 'left-pad';\n");
      }
      fs.writeFileSync(path.join(dir, 'index.js'), "import {\n  a,\n  b,\n} from '@scope/pkg/sub';\n");
      assert.deepEqual([...bareServerImports(dir)], [['@scope/pkg', 'index.js']]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
