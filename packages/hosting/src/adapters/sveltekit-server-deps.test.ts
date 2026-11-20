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
      dependencies: { 'aws-cdk-blocks': '*' },
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
  fs.writeFileSync(path.join(buildDir, 'handler.js'), 'export const handler = () => {};\n');
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
    writeServerChunk(tmp, "import { withAuth } from 'aws-cdk-blocks/server';\nexport const load = withAuth;\n");
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp, skipBuild: true }),
      (err: Error) =>
        err.name === 'SvelteKitUnbundledDependencyError' &&
        err.message.includes('aws-cdk-blocks/server (imported from build/server/chunks/_page.server.ts.js)'),
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
    writeServerChunk(tmp, "import { withAuth } from 'aws-cdk-blocks/server';\n");
    assert.doesNotThrow(() => withBuildProfile({ reuseBuild: 'if-present' }, () => sveltekitAdapter({ projectDir: tmp })));
  });

  void it('still checks a build reused for a deploy', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import { withAuth } from 'aws-cdk-blocks/server';\n");
    assert.throws(
      () => withBuildProfile({ reuseBuild: 'required' }, () => sveltekitAdapter({ projectDir: tmp })),
      rejects('aws-cdk-blocks/server'),
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
    writeServerChunk(tmp, "import { withAuth } from 'aws-cdk-blocks/server';\n");
    ship('', 'aws-cdk-blocks', { 'package.json': '{}' });
    assert.throws(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }), rejects('aws-cdk-blocks/server'));
  });

  void it('rejects a subpath that the package exports do not provide', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import { withAuth } from 'aws-cdk-blocks/server';\n");
    ship('', 'aws-cdk-blocks', {
      'package.json': JSON.stringify({ type: 'module', exports: { '.': './index.js' } }),
      'index.js': 'export {};\n',
      'server.js': 'export const withAuth = 1;\n',
    });
    assert.throws(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }), rejects('aws-cdk-blocks/server'));
  });

  void it('deploys a dependency resolved through its exports map', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import { withAuth } from 'aws-cdk-blocks/server';\n");
    ship('', 'aws-cdk-blocks', {
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
    writeServerChunk(tmp, "import { withAuth } from 'aws-cdk-blocks/server';\n");
    ship('server', 'aws-cdk-blocks', {
      'package.json': JSON.stringify({ type: 'module', exports: { './server': './server.js' } }),
      'server.js': 'export const withAuth = 1;\n',
    });
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
  });

  void it('rejects a shipped dependency that itself imports a package build/ does not have', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import { withAuth } from 'aws-cdk-blocks/server';\n");
    ship('', 'aws-cdk-blocks', {
      'package.json': JSON.stringify({ type: 'module', exports: { './server': './server.js' } }),
      'server.js': "import { jwtVerify } from 'jose';\nexport const withAuth = jwtVerify;\n",
    });
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp, skipBuild: true }),
      rejects('jose (imported from build/node_modules/aws-cdk-blocks/server.js)'),
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

  void it('rejects a relative import that build/ does not ship', () => {
    scaffold(tmp);
    fs.rmSync(path.join(tmp, 'build', 'handler.js'));
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp, skipBuild: true }),
      rejects('./handler.js (imported from build/index.js)'),
    );
  });

  void it('rejects an import that resolves outside build/, through a relative path or a symlink', () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(outside, 'linked-pkg'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'lib.js'), 'export const lib = 1;\n');
    fs.writeFileSync(path.join(outside, 'linked-pkg', 'package.json'), JSON.stringify({ exports: './index.js' }));
    fs.writeFileSync(path.join(outside, 'linked-pkg', 'index.js'), 'export {};\n');
    const chunks = path.join(tmp, 'build', 'server', 'chunks');
    for (const [source, named] of [
      ["import { lib } from '../../../outside/lib.js';\n", '../../../outside/lib.js'],
      ["import { lib } from './lib.js';\n", './lib.js'],
      ["import 'linked-pkg';\n", 'linked-pkg'],
    ]) {
      fs.rmSync(path.join(tmp, 'build'), { recursive: true, force: true });
      scaffold(tmp);
      fs.symlinkSync(path.join(outside, 'lib.js'), path.join(chunks, 'lib.js'));
      fs.mkdirSync(path.join(tmp, 'build', 'node_modules'), { recursive: true });
      fs.symlinkSync(path.join(outside, 'linked-pkg'), path.join(tmp, 'build', 'node_modules', 'linked-pkg'));
      writeServerChunk(tmp, source);
      assert.throws(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }), rejects(named), source);
    }
  });

  void it('deploys an import through a symlink that stays inside build/', () => {
    scaffold(tmp);
    const chunks = path.join(tmp, 'build', 'server', 'chunks');
    fs.writeFileSync(path.join(tmp, 'build', 'server', 'shared.js'), 'export const shared = 1;\n');
    fs.symlinkSync(path.join(tmp, 'build', 'server', 'shared.js'), path.join(chunks, 'alias.js'));
    writeServerChunk(tmp, "import { shared } from './alias.js';\nexport { shared };\n");
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
  });

  void it('rejects a dynamic import that a try returns without awaiting, as its rejection escapes the catch', () => {
    scaffold(tmp);
    writeServerChunk(
      tmp,
      [
        "export const a = async () => { try { return import('returned-peer'); } catch { return null; } };",
        "export const b = () => { try { const p = import('unawaited-peer'); return p; } catch { return null; } };",
        '',
      ].join('\n'),
    );
    assert.throws(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }), rejects('returned-peer', 'unawaited-peer'));
  });

  void it('deploys a dynamic import that a try awaits, and a require that a try surrounds', () => {
    scaffold(tmp);
    writeServerChunk(
      tmp,
      [
        "export const a = async () => { try { return await import('awaited-peer'); } catch { return null; } };",
        "export const b = async () => { try { return await import('chained-peer').then((m) => m.default); } catch { return null; } };",
        "export const c = () => { try { return require('sync-peer'); } catch { return null; } };",
        '',
      ].join('\n'),
    );
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
  });

  void it('reads a trailing slash as the npm package, not the built-in: require("buffer/")', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "const { Buffer } = require('buffer/');\nconst fsp = require('fs/promises');\nmodule.exports = { Buffer, fsp };\n");
    assert.throws(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }), rejects('buffer/'));
    ship('', 'buffer', { 'package.json': JSON.stringify({ main: 'index.js' }), 'index.js': 'exports.Buffer = 1;\n' });
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
  });

  void it('resolves require("pkg/subdir") through the subdirectory package.json main, as Node.js does', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "module.exports = require('pkg/subdir');\n");
    ship('', 'pkg', {
      'package.json': JSON.stringify({ main: 'index.js' }),
      'index.js': 'module.exports = 1;\n',
      'subdir/package.json': JSON.stringify({ main: 'lib/entry.js' }),
      'subdir/lib/entry.js': 'module.exports = 2;\n',
    });
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
  });

  void it('rejects require("./x") when only x.cjs exists, as Node.js adds .js, .json and .node only', () => {
    scaffold(tmp);
    fs.writeFileSync(path.join(tmp, 'build', 'server', 'chunks', 'helper.cjs'), 'module.exports = 1;\n');
    writeServerChunk(tmp, "module.exports = require('./helper');\n");
    assert.throws(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }), rejects('./helper'));
  });

  void it('lets require() look further up when the nearest node_modules copy has no module, as CommonJS does', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "module.exports = require('dup');\n");
    fs.mkdirSync(path.join(tmp, 'build', 'server', 'node_modules', 'dup'), { recursive: true });
    ship('', 'dup', { 'package.json': JSON.stringify({ main: 'index.js' }), 'index.js': 'module.exports = 1;\n' });
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
  });

  void it('resolves a package-internal # import through the package.json imports field', () => {
    scaffold(tmp);
    writeServerChunk(tmp, "import 'with-imports';\n");
    ship('', 'with-imports', {
      'package.json': JSON.stringify({ type: 'module', exports: './index.js', imports: { '#internal/*': './lib/*.js' } }),
      'index.js': "import '#internal/util';\n",
      'lib/util.js': 'export {};\n',
    });
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
    fs.rmSync(path.join(tmp, 'build', 'node_modules', 'with-imports', 'lib', 'util.js'));
    assert.throws(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }), rejects('#internal/util'));
  });

  void it('accepts an import or require() of an AWS SDK package the Lambda runtime ships, not one it lacks', () => {
    scaffold(tmp);
    // The runtime's Node.js falls back to NODE_PATH (which includes /var/runtime/node_modules) for ESM too.
    writeServerChunk(
      tmp,
      [
        "import { S3Client } from '@aws-sdk/client-s3';",
        "const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');",
        "const { marshall } = require('@aws-sdk/util-dynamodb');",
        'export { S3Client, DynamoDBClient, marshall };',
        '',
      ].join('\n'),
    );
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
    writeServerChunk(
      tmp,
      [
        "const { LambdaWebClient } = require('@aws-sdk/client-lambda-web');",
        "import { NotAClient } from '@aws-sdk/client-not-in-the-runtime';",
        "const v2 = require('aws-sdk');",
        'export { LambdaWebClient, NotAClient, v2 };',
        '',
      ].join('\n'),
    );
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp, skipBuild: true }),
      rejects('@aws-sdk/client-lambda-web', '@aws-sdk/client-not-in-the-runtime', 'aws-sdk (imported from'),
    );
  });

  void it('resolves the imports of a symlinked file from where build/ has it, as the ZIP stores it there', () => {
    scaffold(tmp);
    const server = path.join(tmp, 'build', 'server');
    fs.mkdirSync(path.join(server, 'shared'));
    fs.writeFileSync(path.join(server, 'shared', 'impl.js'), "import { h } from './helper.js';\nexport const impl = h;\n");
    fs.writeFileSync(path.join(server, 'shared', 'helper.js'), 'export const h = 1;\n');
    fs.symlinkSync(path.join(server, 'shared', 'impl.js'), path.join(server, 'chunks', 'alias.js'));
    writeServerChunk(tmp, "import { impl } from './alias.js';\nexport { impl };\n");
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp, skipBuild: true }),
      rejects('./helper.js (imported from build/server/chunks/alias.js)'),
    );
    fs.writeFileSync(path.join(server, 'chunks', 'helper.js'), 'export const h = 2;\n');
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
  });

  void it('does not scan scripts that a directory symlink in build/ reaches outside it', () => {
    scaffold(tmp);
    const outside = path.join(tmp, 'outside-tools');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'tool.js'), "import 'left-pad';\n");
    fs.symlinkSync(outside, path.join(tmp, 'build', 'server', 'tools'));
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
  });

  void it('lets an optional load fall back when the shipped file it loads has a missing dependency', () => {
    scaffold(tmp);
    const chunks = path.join(tmp, 'build', 'server', 'chunks');
    fs.writeFileSync(path.join(chunks, 'tracing.js'), "import 'missing-otel';\nexport const trace = 1;\n");
    fs.writeFileSync(path.join(chunks, 'tracing-cjs.js'), "module.exports = require('missing-cjs-otel');\n");
    writeServerChunk(
      tmp,
      [
        "let t; try { t = await import('./tracing.js'); } catch { t = null; }",
        "let c; try { c = require('./tracing-cjs.js'); } catch { c = null; }",
        'export { t, c };',
        '',
      ].join('\n'),
    );
    assert.doesNotThrow(() => sveltekitAdapter({ projectDir: tmp, skipBuild: true }));
    // A required path to the same file makes its dependency required.
    fs.writeFileSync(path.join(chunks, 'hooks.js'), "import { trace } from './tracing.js';\nexport { trace };\n");
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp, skipBuild: true }),
      rejects('missing-otel (imported from build/server/chunks/tracing.js)'),
    );
  });

  void it('rejects a require() with a promise handler, as require() throws before the handler attaches', () => {
    scaffold(tmp);
    writeServerChunk(
      tmp,
      [
        "const a = require('plugin-a').catch(() => null);",
        "const b = require('plugin-b').then((m) => m, () => null);",
        "const c = import('plugin-c').catch(() => null);",
        'module.exports = { a, b, c };',
        '',
      ].join('\n'),
    );
    assert.throws(
      () => sveltekitAdapter({ projectDir: tmp, skipBuild: true }),
      (err: Error) => rejects('plugin-a', 'plugin-b')(err) && !err.message.includes('plugin-c'),
    );
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

  const build = (args: string[] = [], outFile = path.join('out', 'entry.js')): string => {
    const result = withViteBundlePreload(process.env, (env) =>
      spawnSync(process.execPath, [viteBin ?? '', 'build', ...args], { cwd: tmp, env, encoding: 'utf-8' }),
    );
    assert.equal(result.status, 0, `vite build failed: ${String(result.stderr)}`);
    return fs.readFileSync(path.join(tmp, outFile), 'utf-8');
  };

  /** The output bundles dep-a and keeps the config's `ssr.external` dep-b as an import. */
  const assertBundled = (output: string): void => {
    assert.ok(output.includes('from-dep-a'), 'dep-a is bundled');
    assert.ok(!/from ['"]dep-a['"]/.test(output), 'no import of dep-a is left');
    assert.match(output, /from ['"]dep-b['"]/, 'an explicit ssr.external stays an import');
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

  void it('wraps the config in the root that the build command names after its options', () => {
    // `vite build --mode staging frontend`: the root is `frontend`, so Vite loads frontend/vite.config.*.
    fs.mkdirSync(path.join(tmp, 'frontend'));
    fs.renameSync(path.join(tmp, 'entry.js'), path.join(tmp, 'frontend', 'entry.js'));
    fs.writeFileSync(path.join(tmp, 'frontend', 'vite.config.mjs'), config(false));
    assertBundled(build(['--mode', 'staging', 'frontend'], path.join('frontend', 'out', 'entry.js')));
    assert.equal(fs.readFileSync(path.join(tmp, 'frontend', 'vite.config.mjs'), 'utf-8'), config(false));
  });

  void it('keeps a vite.config.js CommonJS in a package without "type": "module", so its require() works', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'p', dependencies: { 'dep-a': '*' } }));
    const helper = path.join(tmp, 'node_modules', 'cfg-helper-cjs');
    fs.mkdirSync(helper, { recursive: true });
    fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({ name: 'cfg-helper-cjs', main: 'index.js' }));
    fs.writeFileSync(path.join(helper, 'index.js'), "module.exports = { value: '-cjs' };\n");
    fs.writeFileSync(
      path.join(tmp, 'vite.config.js'),
      "const { value } = require('cfg-helper-cjs');\n" +
        'module.exports = ({ mode }) => ({\n' +
        '  define: { __MODE__: JSON.stringify(mode + value) },\n' +
        "  build: { ssr: 'entry.js', outDir: 'out' },\n" +
        "  ssr: { external: ['dep-b'] },\n" +
        '});\n',
    );
    // In a CommonJS package Vite names the ESM server output entry.mjs.
    assertBundled(build([], path.join('out', 'entry.mjs')));
  });

  void it('wraps the config Vite picks when several exist: vite.config.cjs before vite.config.mts', () => {
    fs.writeFileSync(
      path.join(tmp, 'vite.config.cjs'),
      "module.exports = { build: { ssr: 'entry.js', outDir: 'out' }, ssr: { external: ['dep-b'] } };\n",
    );
    fs.writeFileSync(path.join(tmp, 'vite.config.mts'), "export default { build: { ssr: 'entry.js', outDir: 'not-this-one' } };\n");
    assertBundled(build());
    assert.ok(!fs.existsSync(path.join(tmp, 'not-this-one')), 'the vite.config.mts is not loaded');
  });
});

/**
 * The preload's config selection, against a stand-in `vite/bin/vite.js` that
 * prints the arguments it gets and the bridge config they point at. Vite's own
 * rules (vite/src/node/config.ts `loadConfigFromFile`, constants.ts
 * `DEFAULT_CONFIG_FILES`, cli.ts with cac): an explicit `--config` resolves from
 * the working directory; otherwise the first of vite.config.{js,mjs,ts,cjs,mts,cts}
 * in the root, which is the first positional after `build` (else the working
 * directory); a `.js`/`.ts` config is CommonJS unless the nearest package.json
 * says `"type": "module"`.
 */
void describe('the bundling preload wraps the config Vite would load', () => {
  let tmp: string;
  let fakeVite: string;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sveltekit-vite-select-')));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'p', type: 'module' }));
    const viteDir = path.join(tmp, 'node_modules', 'vite');
    fs.mkdirSync(path.join(viteDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(viteDir, 'package.json'), JSON.stringify({ name: 'vite' }));
    fakeVite = path.join(viteDir, 'bin', 'vite.js');
    fs.writeFileSync(
      fakeVite,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        'const args = process.argv.slice(2);',
        "const i = args.lastIndexOf('--config');",
        "const bridgePath = i >= 0 && path.basename(path.dirname(args[i + 1])).startsWith('aws-blocks-sveltekit-') ? args[i + 1] : null;",
        "const bridge = bridgePath ? fs.readFileSync(bridgePath, 'utf-8') : null;",
        'process.stdout.write(JSON.stringify({ args, bridgePath, bridge }));',
        '',
      ].join('\n'),
    );
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const write = (...files: string[]): void => {
    for (const rel of files) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), 'export default {};\n');
    }
  };

  type Run = { args: string[]; bridgePath: string | null; bridge: string | null };
  const run = (args: string[]): Run => {
    const result = withViteBundlePreload(process.env, (env) =>
      spawnSync(process.execPath, [fakeVite, ...args], { cwd: tmp, env, encoding: 'utf-8' }),
    );
    assert.equal(result.status, 0, String(result.stderr));
    return JSON.parse(result.stdout) as Run;
  };

  /** The project-relative config file that the bridge loads, `null` for none. */
  const wrapped = (out: Run): string | null => {
    assert.ok(out.bridgePath && out.bridge, `the build is wrapped: ${JSON.stringify(out.args)}`);
    const m = /(?:from |require\()("[^"]*")/.exec(out.bridge);
    if (!m?.[1]) return null;
    const file = path.resolve(path.dirname(out.bridgePath), JSON.parse(m[1]) as string);
    return path.relative(tmp, fs.realpathSync(file)).split(path.sep).join('/');
  };

  const unchanged = (args: string[]): void => {
    const out = run(args);
    assert.deepEqual(out.args, args, 'the build runs as the command wrote it');
    assert.equal(out.bridgePath, null);
  };

  for (const args of [
    ['build', '--mode', 'staging', 'frontend'],
    ['--mode', 'staging', 'build', 'frontend'],
    ['build', '-m', 'staging', '--emptyOutDir', 'frontend'],
    ['build', '--mode=staging', '-w', 'frontend'],
    ['build', 'frontend', '--outDir', 'dist'],
  ]) {
    void it(`loads the root's config for \`vite ${args.join(' ')}\``, () => {
      write('vite.config.js', 'frontend/vite.config.ts');
      const out = run(args);
      assert.equal(wrapped(out), 'frontend/vite.config.ts');
      assert.deepEqual(out.args, [...args, '--config', out.bridgePath], 'every other argument stays');
    });
  }

  void it('reads the word after an option that takes an optional value as its value, as Vite does', () => {
    // `--ssr [entry]`: `vite build --ssr frontend` builds the SSR entry `frontend` from the working directory.
    write('vite.config.js', 'frontend/vite.config.ts');
    assert.equal(wrapped(run(['build', '--ssr', 'frontend'])), 'vite.config.js');
  });

  for (const [present, expected] of [
    [['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.cjs', 'vite.config.mts', 'vite.config.cts'], 'vite.config.js'],
    [['vite.config.mjs', 'vite.config.ts', 'vite.config.cjs', 'vite.config.mts', 'vite.config.cts'], 'vite.config.mjs'],
    [['vite.config.ts', 'vite.config.cjs', 'vite.config.mts', 'vite.config.cts'], 'vite.config.ts'],
    [['vite.config.cjs', 'vite.config.mts', 'vite.config.cts'], 'vite.config.cjs'],
    [['vite.config.mts', 'vite.config.cts'], 'vite.config.mts'],
    [['vite.config.cts'], 'vite.config.cts'],
  ] as const) {
    void it(`picks ${expected} from ${present.join(', ')}, in Vite's order`, () => {
      write(...present);
      assert.equal(wrapped(run(['build'])), expected);
    });
  }

  for (const args of [
    ['build', '-c', 'configs/custom.mjs', 'frontend'],
    ['build', '--config=configs/custom.mjs', 'frontend'],
  ]) {
    void it(`wraps the --config file from the working directory, not the root, for \`vite ${args.join(' ')}\``, () => {
      write('configs/custom.mjs', 'frontend/configs/custom.mjs', 'frontend/vite.config.js');
      const out = run(args);
      assert.equal(wrapped(out), 'configs/custom.mjs');
      assert.deepEqual(out.args, ['build', '--config', out.bridgePath, 'frontend']);
    });
  }

  void it('wraps no config when the root has none, as Vite then loads none', () => {
    write('other/vite.config.js');
    const out = run(['build']);
    assert.equal(wrapped(out), null);
    assert.match(out.bridge ?? '', /const userConfig = \{\};/);
  });

  for (const [why, args, files] of [
    ['a --config file that does not exist', ['build', '--config', 'missing.mjs'], ['vite.config.js']],
    ['two --config options', ['build', '--config', 'a.mjs', '--config', 'b.mjs'], ['a.mjs', 'b.mjs']],
    ['--config inside combined short flags', ['build', '-wc', 'a.mjs'], ['a.mjs', 'vite.config.js']],
    ['an option this Vite CLI table does not know', ['build', '--new-vite-option', 'x'], ['vite.config.js', 'x/vite.config.js']],
    ['another command than build', ['dev'], ['vite.config.js']],
  ] as const) {
    void it(`leaves the build unchanged for ${why}`, () => {
      write(...files);
      unchanged([...args]);
    });
  }

  for (const [file, pkg, bridgeExt] of [
    ['frontend/vite.config.js', {}, '.cjs'],
    ['frontend/vite.config.ts', { type: 'commonjs' }, '.cjs'],
    ['frontend/vite.config.cts', { type: 'module' }, '.cjs'],
    ['frontend/vite.config.js', { type: 'module' }, '.mjs'],
    ['frontend/vite.config.mts', {}, '.mjs'],
  ] as const) {
    void it(`keeps ${path.basename(file)} ${bridgeExt === '.cjs' ? 'CommonJS' : 'ESM'} under a package.json of ${JSON.stringify(pkg)}`, () => {
      write(file);
      fs.writeFileSync(path.join(tmp, 'frontend', 'package.json'), JSON.stringify(pkg));
      const out = run(['build', 'frontend']);
      assert.equal(wrapped(out), file);
      assert.equal(path.extname(out.bridgePath ?? ''), bridgeExt);
      assert.match(out.bridge ?? '', bridgeExt === '.cjs' ? /require\(/ : /^import userConfig from /m);
    });
  }
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
