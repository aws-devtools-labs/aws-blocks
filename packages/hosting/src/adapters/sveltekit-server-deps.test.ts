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
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { spawn } from './spawn.js';
import { sveltekitAdapter } from './sveltekit.js';
import { unresolvedServerImports, withViteBundlePreload } from './sveltekit-server-deps.js';
import { withBuildProfile } from './shared/build_profile.js';

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
        err.message.includes('@aws-blocks/blocks/server (imported from build/server/chunks/_page.server.ts.js)'),
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

  /** Ship a package under `build/<at>/node_modules/<name>` with the given files (`package.json` included). */
  const ship = (at: string, name: string, files: Record<string, string>): void => {
    const pkgDir = path.join(tmp, 'build', at, 'node_modules', name);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(pkgDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, rel), content);
    }
  };

  const rejects = (...named: string[]) => (err: Error) =>
    err.name === 'SvelteKitUnbundledDependencyError' && named.every((n) => err.message.includes(n));

  void it('does not check a build reused for a destroy, so a stale build/ cannot block stack deletion', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import { withAuth } from '@aws-blocks/blocks/server';\n");
    assert.doesNotThrow(() => withBuildProfile({ reuseBuild: 'if-present' }, () => sveltekitAdapter({ projectDir: tmp })));
  });

  void it('still checks a build reused for a deploy', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import { withAuth } from '@aws-blocks/blocks/server';\n");
    assert.throws(
      () => withBuildProfile({ reuseBuild: 'required' }, () => sveltekitAdapter({ projectDir: tmp })),
      rejects('@aws-blocks/blocks/server'),
    );
  });

  void it('does not read import text inside strings or templates as imports', () => {
    scaffold(tmp);
    writeServerChunk(
      tmp,
      [
        `const sample = "import('example-package')";`,
        "const tpl = `import x from 'left-pad'; export * from \"right-pad\"`;",
        "const re = /import\\('regex-package'\\)/;",
        'export { sample, tpl, re };',
        '',
      ].join('\n'),
    );
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
  });

  void it('finds static imports after another statement on the same line, as minified output has them', () => {
    scaffold(tmp);
    writeServerChunk(tmp, 'const a=1;import{b}from"left-pad";import"side-effect-pkg";export{a,b};\n');
    assert.throws(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }), rejects('left-pad', 'side-effect-pkg'));
  });

  void it('rejects a dependency whose copy in build/node_modules has no module for the import', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import { withAuth } from '@aws-blocks/blocks/server';\n");
    ship('', '@aws-blocks/blocks', { 'package.json': '{}' });
    assert.throws(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }), rejects('@aws-blocks/blocks/server'));
  });

  void it('rejects a subpath that the package exports do not provide', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import { withAuth } from '@aws-blocks/blocks/server';\n");
    ship('', '@aws-blocks/blocks', {
      'package.json': JSON.stringify({ type: 'module', exports: { '.': './index.js' } }),
      'index.js': 'export {};\n',
      'server.js': 'export const withAuth = 1;\n',
    });
    assert.throws(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }), rejects('@aws-blocks/blocks/server'));
  });

  void it('deploys a dependency resolved through its exports map', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import { withAuth } from '@aws-blocks/blocks/server';\n");
    ship('', '@aws-blocks/blocks', {
      'package.json': JSON.stringify({
        type: 'module',
        exports: { './server': { types: './dist/server.d.ts', import: './dist/server.js', require: './dist/server.cjs' } },
      }),
      'dist/server.js': "import { helper } from './helper.js';\nexport const withAuth = helper;\n",
      'dist/helper.js': 'export const helper = 1;\n',
    });
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
  });

  void it('deploys a dependency shipped in a node_modules next to the importing chunk', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import { withAuth } from '@aws-blocks/blocks/server';\n");
    ship('server', '@aws-blocks/blocks', {
      'package.json': JSON.stringify({ type: 'module', exports: { './server': './server.js' } }),
      'server.js': 'export const withAuth = 1;\n',
    });
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
  });

  void it('rejects a shipped dependency that itself imports a package build/ does not have', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import { withAuth } from '@aws-blocks/blocks/server';\n");
    ship('', '@aws-blocks/blocks', {
      'package.json': JSON.stringify({ type: 'module', exports: { './server': './server.js' } }),
      'server.js': "import { jwtVerify } from 'jose';\nexport const withAuth = jwtVerify;\n",
    });
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp, skipBuild: true }),
      rejects('jose (imported from build/node_modules/@aws-blocks/blocks/server.js)'),
    );
  });

  void it('deploys a server whose optional dynamic imports fall back when the package is absent', () => {
    scaffold(tmp);
    writeServerChunk(
      tmp,
      [
        'let impl;',
        "try { impl = await import('optional-peer'); } catch { impl = { render: () => 'fallback' }; }",
        "const other = await import('other-peer').catch(() => null);",
        "const third = await import('third-peer').then((m) => m, () => null);",
        'export const render = () => impl.render(other, third);',
        '',
      ].join('\n'),
    );
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
  });

  void it('rejects a dynamic import that a finally, not a catch, surrounds', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "try { await import('cookie'); } finally { console.log('x'); }\n");
    assert.throws(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }), rejects('cookie'));
  });

  void it('checks the require calls of a shipped CommonJS dependency, except a guarded optional one', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import ws from 'ws';\nexport default ws;\n");
    ship('', 'ws', {
      'package.json': JSON.stringify({ main: 'index.js' }),
      'index.js': "let bu;\ntry { bu = require('bufferutil'); } catch { bu = null; }\nmodule.exports = require('./lib/websocket');\n",
      'lib/websocket.js': "const { EventEmitter } = require('events');\nmodule.exports = class extends EventEmitter {};\n",
    });
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
    fs.appendFileSync(path.join(tmp, 'build', 'node_modules', 'ws', 'lib', 'websocket.js'), "require('utf-8-validate');\n");
    assert.throws(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }), rejects('utf-8-validate'));
  });

  /**
   * Every path under `dir` with its content, except `build/` (the output the
   * build writes) and `node_modules/.cache` (where reading svelte.config caches).
   */
  const projectSnapshot = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (rel: string): void => {
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const child = path.join(rel, entry.name);
        if (child === 'build' || child === path.join('node_modules', '.cache')) continue;
        if (entry.isDirectory()) walk(child);
        else out[child] = fs.readFileSync(path.join(dir, child), 'utf-8');
      }
    };
    walk('');
    return out;
  };

  void it('never writes to the project for the bundling, so overlapping builds keep vite.config.ts', () => {
    scaffold(tmp, { viteConfig: VITE_CONFIG });
    const before = projectSnapshot(tmp);
    const seen: { during: Record<string, string>; nodeOptions: string }[] = [];
    let depth = 0;
    mock.method(spawn, 'sync', (_bin: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      depth++;
      // A second build of the same app starts while the first one runs.
      if (depth === 1) sveltekitAdapter({ projectDir: tmp });
      seen.push({ during: projectSnapshot(tmp), nodeOptions: opts.env.NODE_OPTIONS ?? '' });
    });
    sveltekitAdapter({ projectDir: tmp });
    assert.equal(seen.length, 2);
    for (const { during } of seen) assert.deepEqual(during, before, 'the project is untouched while a build runs');
    assert.deepEqual(projectSnapshot(tmp), before);
    const preloads = seen.map(({ nodeOptions }) => /--import=(\S+)/.exec(nodeOptions)?.[1]);
    assert.ok(preloads[0] && preloads[1], 'each build loads the bundling preload');
    assert.notEqual(preloads[0], preloads[1], 'each build has its own preload');
    for (const preload of preloads) {
      assert.ok(!fs.existsSync(new URL(preload ?? '')), 'the preload is removed after the build');
    }
  });

  void it('removes the preload when the build fails', () => {
    scaffold(tmp, { viteConfig: VITE_CONFIG });
    let preload = '';
    mock.method(spawn, 'sync', (_bin: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      preload = /--import=(\S+)/.exec(opts.env.NODE_OPTIONS ?? '')?.[1] ?? '';
      throw new Error('vite build failed');
    });
    assert.throws(() => sveltekitAdapter({ projectDir: tmp }), /SvelteKitBuildError/);
    assert.ok(preload, 'the build ran with the preload');
    assert.ok(!fs.existsSync(new URL(preload)));
    assert.equal(fs.readFileSync(path.join(tmp, 'vite.config.ts'), 'utf-8'), VITE_CONFIG);
  });
});

/** Vite from the monorepo's install; the real-build tests skip when it is absent. */
const viteBin = ((): string | undefined => {
  try {
    return path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');
  } catch {
    return undefined;
  }
})();

void describe('withViteBundlePreload — a real `vite build`', { skip: viteBin ? false : 'vite is not installed' }, () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sveltekit-vite-preload-'));
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'p', type: 'module', dependencies: { 'dep-a': '*', 'dep-b': '*' } }),
    );
    for (const name of ['dep-a', 'dep-b', 'cfg-helper']) {
      const dir = path.join(tmp, 'node_modules', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js' }));
      fs.writeFileSync(path.join(dir, 'index.js'), `export const value = 'from-${name}';\n`);
    }
    fs.writeFileSync(
      path.join(tmp, 'entry.js'),
      "import { value as a } from 'dep-a';\nimport { value as b } from 'dep-b';\nexport const x = a + b;\n",
    );
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A config in the app's own style: it imports a package, and the `.ts` one annotates its parameter. */
  const config = (ts: boolean): string =>
    `import { value } from 'cfg-helper';\n` +
    `export default (${ts ? '{ mode }: { mode: string }' : '{ mode }'}) => ({\n` +
    `  define: { __MODE__: JSON.stringify(mode + value) },\n` +
    `  build: { ssr: 'entry.js', outDir: 'out' },\n` +
    `  ssr: { external: ['dep-b'] },\n` +
    `});\n`;

  const build = (args: string[] = []): string => {
    const result = withViteBundlePreload(process.env, (env) =>
      spawnSync(process.execPath, [viteBin ?? '', 'build', ...args], { cwd: tmp, env, encoding: 'utf-8' }),
    );
    assert.equal(result.status, 0, `vite build failed: ${String(result.stderr)}`);
    return fs.readFileSync(path.join(tmp, 'out', 'entry.js'), 'utf-8');
  };

  for (const file of ['vite.config.ts', 'vite.config.mjs']) {
    void it(`bundles the server's dependencies with the app's ${file}, which stays untouched`, () => {
      fs.writeFileSync(path.join(tmp, file), config(file.endsWith('.ts')));
      const listing = fs.readdirSync(tmp).sort();
      const output = build();
      assert.ok(output.includes('from-dep-a'), 'dep-a is bundled');
      assert.ok(!/from ['"]dep-a['"]/.test(output), 'no import of dep-a is left');
      assert.match(output, /from ['"]dep-b['"]/, 'an explicit ssr.external stays an import');
      assert.equal(fs.readFileSync(path.join(tmp, file), 'utf-8'), config(file.endsWith('.ts')));
      assert.deepEqual(fs.readdirSync(tmp).sort(), [...listing, 'out'].sort(), 'the build adds nothing but its output');
    });
  }

  void it('wraps the config that the build command names with --config', () => {
    fs.writeFileSync(path.join(tmp, 'custom.config.ts'), config(true));
    const output = build(['--config', 'custom.config.ts']);
    assert.ok(output.includes('from-dep-a'));
    assert.match(output, /from ['"]dep-b['"]/);
  });
});

void describe('unresolvedServerImports', () => {
  void it('skips client assets and prerendered pages', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sveltekit-bare-'));
    try {
      for (const rel of ['client/_app/a.js', 'prerendered/b.js']) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), "import 'left-pad';\n");
      }
      fs.writeFileSync(path.join(dir, 'index.js'), "import {\n  a,\n  b,\n} from '@scope/pkg/sub';\n");
      assert.deepEqual([...unresolvedServerImports(dir)], [['@scope/pkg/sub', 'index.js']]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
