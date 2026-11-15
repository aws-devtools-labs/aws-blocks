// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Astro adapter internals — focused on the image-service / sharp-bundling
// logic added for issue #3 (`/_image` → `content-type: image/null` on the
// noop passthrough service).

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { spawn } from './spawn.js';
import { withBuildProfile } from './shared/build_profile.js';
import {
  astroAdapter,
  astroUsesSharpService,
  installSharpForAstroSsr,
  patchAstroRemoteImageRedirects,
  ASTRO_REDIRECT_PATCH_MARKER,
  ensureSsrBuildOutput,
} from './astro.js';

void describe('astroUsesSharpService — decide whether to ship sharp (issue #3)', () => {
  it('returns true when no image.service is configured (Astro default = sharp)', () => {
    assert.equal(astroUsesSharpService({}), true);
    assert.equal(astroUsesSharpService({ image: {} }), true);
    assert.equal(astroUsesSharpService({ image: { domains: ['x.com'] } }), true);
  });

  it('returns true when the sharp service is explicitly configured', () => {
    assert.equal(
      astroUsesSharpService({
        image: { service: { entrypoint: 'astro/assets/services/sharp' } },
      }),
      true,
    );
  });

  it('returns FALSE for the noop passthrough service (opted out)', () => {
    assert.equal(
      astroUsesSharpService({
        image: { service: { entrypoint: 'astro/assets/services/noop' } },
      }),
      false,
    );
  });

  it('returns FALSE for a custom (non-sharp) service', () => {
    assert.equal(
      astroUsesSharpService({
        image: { service: { entrypoint: './my/custom-image-service' } },
      }),
      false,
    );
  });
});

void describe('installSharpForAstroSsr — idempotency + guard', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-sharp-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Lay down what a real install leaves behind: sharp's package.json plus the
  // `@img/sharp-linux-x64` prebuilt marker package.
  const seedSharp = (version: string): void => {
    const sharpDir = path.join(tmp, 'node_modules', 'sharp');
    fs.mkdirSync(sharpDir, { recursive: true });
    fs.writeFileSync(path.join(sharpDir, 'package.json'), JSON.stringify({ name: 'sharp', version }));
    const marker = path.join(tmp, 'node_modules', '@img', 'sharp-linux-x64');
    fs.mkdirSync(marker, { recursive: true });
    fs.writeFileSync(path.join(marker, 'package.json'), JSON.stringify({ name: '@img/sharp-linux-x64', version }));
  };

  it('is a no-op when a patched linux-x64 sharp is already present (no npm install)', () => {
    // Pre-seed the marker package so the installer short-circuits BEFORE it
    // would shell out to npm — proves idempotency without network/npm.
    seedSharp('0.35.5');
    // Must not throw and must not have created a package.json (short-circuit
    // returns before writing one).
    assert.doesNotThrow(() => installSharpForAstroSsr(tmp));
    assert.equal(
      fs.existsSync(path.join(tmp, 'package.json')),
      false,
      'short-circuit must happen before any package.json is written',
    );
  });

  // GHSA-wq5f-xc86-pv6w: every sharp below 0.35.5 bundles a librsvg with a
  // use-after-free that can lead to RCE on glibc Linux (the Lambda runtime).
  it('installs a sharp range that excludes every vulnerable version', () => {
    const installs: (readonly string[])[] = [];
    mock.method(spawn, 'sync', (_bin: string, args: readonly string[]) => {
      installs.push(args);
    });
    try {
      installSharpForAstroSsr(tmp);
    } finally {
      mock.restoreAll();
    }
    assert.strictEqual(installs.length, 1);
    const spec = installs[0].find((a) => a.startsWith('sharp@'));
    assert.ok(spec, 'npm install must name sharp explicitly');
    const range = spec.slice('sharp@'.length);
    assert.ok(semver.subset(range, '>=0.35.5'), `sharp range ${range} admits versions below 0.35.5`);
  });

  it('reinstalls when the bundle already holds a vulnerable linux-x64 sharp', () => {
    seedSharp('0.34.5');
    let installs = 0;
    mock.method(spawn, 'sync', () => {
      installs++;
    });
    try {
      installSharpForAstroSsr(tmp);
    } finally {
      mock.restoreAll();
    }
    assert.strictEqual(installs, 1, 'a bundled sharp 0.34.5 must not satisfy the idempotency check');
  });

  it('throws AstroSharpInstallError when npm install exits non-zero (fails loudly, not silently)', () => {
    // Shadow `npm` with a fake that always exits 1, mimicking a registry
    // timeout / resolution conflict WITHOUT touching the network. The local
    // spawn.sync wrapper turns that non-zero exit into a throw, which the
    // installer wraps in HostingError('AstroSharpInstallError'). Regression
    // guard for the "silently swallowed failed install" concern (PR #177).
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-npm-'));
    const npmShim = path.join(binDir, 'npm');
    fs.writeFileSync(npmShim, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
    try {
      assert.throws(
        () => installSharpForAstroSsr(tmp),
        /AstroSharpInstallError|exit(ed)? code 1/,
        'a failed npm install must throw, not proceed silently',
      );
      // The package.json created for the install is cleaned up on failure, so a
      // retry isn't fooled by a stale `hadPkgJson === true`.
      assert.equal(
        fs.existsSync(path.join(tmp, 'package.json')),
        false,
        'the just-written package.json must be removed on install failure',
      );
    } finally {
      process.env.PATH = prevPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

// NOTE: these tests validate the patch's SHAPE LOGIC against a hand-written,
// friendly-named fixture chunk (readable identifiers like `isRemoteAllowed`).
// Real Vite/Rollup output may minify those to single letters, in which case
// the guard `if (!/isRemoteAllowed/.test(src)) continue` skips silently. Green
// here therefore does NOT prove the patch fires on a production bundle — that
// coverage comes from the integration deploy (the astro-ssr e2e image tests).
void describe('patchAstroRemoteImageRedirects — follow allowlisted redirects safely', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-redir-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // A minimal stand-in for the Astro assets chunk: imports isRemoteAllowed,
  // has the allowlist check + the manual-redirect fetch Astro core emits.
  const CHUNK = `import { i as isRemoteAllowed } from './remote.mjs';
async function loadRemoteImage(url, imageConfig) {
  const allowlistConfig = imageConfig ? { domains: imageConfig.domains ?? [], remotePatterns: imageConfig.remotePatterns ?? [] } : void 0;
  if (allowlistConfig && !isRemoteAllowed(url, allowlistConfig)) { throw new Error('not allowed'); }
  const response = await fetch(url, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) { throw new Error('3xx'); }
  return response;
}
export { loadRemoteImage };
`;

  const writeChunk = (contents: string): string => {
    const f = path.join(tmp, 'chunks', '_astro_assets_ABC.mjs');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, contents);
    return f;
  };

  void it('rewrites the manual-redirect fetch to the allowlist-aware helper + injects it', () => {
    const f = writeChunk(CHUNK);
    patchAstroRemoteImageRedirects(tmp);
    const out = fs.readFileSync(f, 'utf-8');
    assert.match(out, new RegExp(`async function ${ASTRO_REDIRECT_PATCH_MARKER}\\(`), 'helper injected');
    assert.match(out, new RegExp(`await ${ASTRO_REDIRECT_PATCH_MARKER}\\(url,`), 'fetch call rewritten');
    // The raw manual-redirect fetch call is gone.
    assert.doesNotMatch(out, /await fetch\(url, \{ redirect: "manual" \}\)/);
  });

  void it('is idempotent (marker guards a second run)', () => {
    const f = writeChunk(CHUNK);
    patchAstroRemoteImageRedirects(tmp);
    const once = fs.readFileSync(f, 'utf-8');
    patchAstroRemoteImageRedirects(tmp);
    const twice = fs.readFileSync(f, 'utf-8');
    assert.equal(once, twice);
  });

  void it('skips chunks that are not the remote-image chunk (no isRemoteAllowed)', () => {
    const f = writeChunk('export const x = await fetch(u, { redirect: "manual" });\n');
    patchAstroRemoteImageRedirects(tmp);
    const out = fs.readFileSync(f, 'utf-8');
    assert.doesNotMatch(out, new RegExp(ASTRO_REDIRECT_PATCH_MARKER));
  });

  void it('injected helper FOLLOWS an allowed redirect but STOPS at a disallowed one (SSRF-safe)', async () => {
    const f = writeChunk(CHUNK);
    patchAstroRemoteImageRedirects(tmp);
    const out = fs.readFileSync(f, 'utf-8');
    const m = out.match(
      new RegExp(`async function ${ASTRO_REDIRECT_PATCH_MARKER}\\([\\s\\S]*?\\n\\}`),
    );
    assert.ok(m, 'helper body present');

    // Harness: stub fetch to model picsum→fastly (allowed→allowed) and
    // picsum→evil (allowed→disallowed). isAllowed only permits picsum + fastly.
    const harness = `
      ${m[0]}
      const isAllowed = (u) => /(^|\\.)(picsum|fastly)\\.test$/.test(new URL(u).hostname);
      const fetchImpl = async (u) => {
        if (u === 'https://picsum.test/a') return { status: 302, headers: new Map([['location','https://fastly.test/final.jpg']]) };
        if (u === 'https://fastly.test/final.jpg') return { status: 200, headers: new Map() };
        if (u === 'https://picsum.test/evil') return { status: 302, headers: new Map([['location','https://evil.test/x']]) };
        return { status: 500, headers: new Map() };
      };
      globalThis.fetch = (u, opts) => fetchImpl(typeof u === 'string' ? u : u.toString());
      return (async () => {
        const okRes = await ${ASTRO_REDIRECT_PATCH_MARKER}('https://picsum.test/a', { domains: [] }, isAllowed);
        const badRes = await ${ASTRO_REDIRECT_PATCH_MARKER}('https://picsum.test/evil', { domains: [] }, isAllowed);
        return { okStatus: okRes.status, badStatus: badRes.status };
      })();
    `;
    // Map<...>.get(k) mirrors Headers.get(k); the helper uses .headers.get('location').
    // ASTRO_REDIRECT_HELPER is a source STRING injected into the Astro SSR
    // bundle at build time — it's never exported from astro.ts, so there's no
    // symbol to import. Evaluating its body via `new Function` is the only way
    // to exercise the actual injected code path without a full Astro build.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(harness.replace('.headers.get("location")', '.headers.get("location")'));
    const { okStatus, badStatus } = (await fn()) as { okStatus: number; badStatus: number };
    assert.equal(okStatus, 200, 'allowed redirect (picsum→fastly) is followed to the 200');
    assert.equal(badStatus, 302, 'disallowed redirect (picsum→evil) is NOT followed; returns the 3xx for Astro to reject');
  });
});

void describe('ensureSsrBuildOutput — empty dist/client is valid for pure SSR', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-ssr-out-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const scaffold = (opts: { entry: boolean; client: 'absent' | 'empty' | 'files' }) => {
    const distDir = path.join(tmp, 'dist');
    const serverDir = path.join(distDir, 'server');
    const clientDir = path.join(distDir, 'client');
    const serverEntry = path.join(serverDir, 'entry.mjs');
    if (opts.entry) {
      fs.mkdirSync(serverDir, { recursive: true });
      fs.writeFileSync(serverEntry, 'export const handler = () => {};');
    }
    if (opts.client === 'empty') fs.mkdirSync(clientDir, { recursive: true });
    if (opts.client === 'files') {
      fs.mkdirSync(clientDir, { recursive: true });
      fs.writeFileSync(path.join(clientDir, 'favicon.svg'), '<svg/>');
    }
    return { clientDir, serverDir, serverEntry };
  };

  it('does NOT throw when dist/client is empty (no static assets)', () => {
    const { clientDir, serverDir, serverEntry } = scaffold({ entry: true, client: 'empty' });
    assert.doesNotThrow(() => ensureSsrBuildOutput(clientDir, serverDir, serverEntry, 'server'));
    assert.equal(fs.existsSync(clientDir), true);
  });

  it('creates dist/client when it is absent, without throwing', () => {
    const { clientDir, serverDir, serverEntry } = scaffold({ entry: true, client: 'absent' });
    assert.equal(fs.existsSync(clientDir), false);
    assert.doesNotThrow(() => ensureSsrBuildOutput(clientDir, serverDir, serverEntry, 'server'));
    assert.equal(fs.existsSync(clientDir), true);
  });

  it('does NOT throw when dist/client has static assets', () => {
    const { clientDir, serverDir, serverEntry } = scaffold({ entry: true, client: 'files' });
    assert.doesNotThrow(() => ensureSsrBuildOutput(clientDir, serverDir, serverEntry, 'server'));
  });

  it('throws AstroBuildOutputMissingError when the server entry is missing', () => {
    const { clientDir, serverDir, serverEntry } = scaffold({ entry: false, client: 'empty' });
    assert.throws(
      () => ensureSsrBuildOutput(clientDir, serverDir, serverEntry, 'server'),
      /AstroBuildOutputMissingError|build output is missing or empty/,
    );
  });
});

// Adapter-level regression for the reported symptom: `astroAdapter` (not just
// the helper) threw AstroBuildOutputMissingError for a pure-SSR build whose
// dist/client is absent/empty. This drives the whole adapter (skipBuild) and
// asserts the manifest is still valid (SSR route + a real staticAssets.directory).
void describe('astroAdapter — pure-SSR build with empty dist/client (regression: #537)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-adapter-ssr-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('synthesizes without throwing and points staticAssets at the created client dir', () => {
    // Minimal scaffold for `skipBuild: true`: an installed Astro (version gate),
    // a server-output config, and dist/server/entry.mjs — with NO dist/client.
    fs.mkdirSync(path.join(tmp, 'node_modules', 'astro'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'node_modules', 'astro', 'package.json'),
      JSON.stringify({ name: 'astro', version: '5.0.0' }),
    );
    fs.writeFileSync(path.join(tmp, 'astro.config.mjs'), 'export default { output: "server" };\n');
    const serverDir = path.join(tmp, 'dist', 'server');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'entry.mjs'), 'export const handler = () => {};');
    const clientDir = path.join(tmp, 'dist', 'client');
    assert.equal(fs.existsSync(clientDir), false, 'precondition: no dist/client');

    // Before the fix this threw AstroBuildOutputMissingError; a throw here fails
    // the test (the customer-observable symptom).
    const manifest = astroAdapter({ projectDir: tmp, skipBuild: true });

    // The SSR catch-all route is present and the client dir is a real path that
    // the adapter materialized.
    assert.equal(manifest.staticAssets.directory, clientDir);
    assert.equal(fs.existsSync(clientDir), true, 'adapter materialized the absent client dir');
    assert.ok(
      Object.keys(manifest.compute).length > 0,
      'a pure-SSR manifest has a compute (SSR) target',
    );
  });
});

void describe('astroAdapter — remote image allowlist with no image function', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-adapter-allowlist-'));
    fs.mkdirSync(path.join(tmp, 'node_modules', 'astro'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'node_modules', 'astro', 'package.json'), JSON.stringify({ name: 'astro', version: '5.0.0' }));
    fs.writeFileSync(
      path.join(tmp, 'astro.config.mjs'),
      "export default { output: 'server', image: { domains: ['images.example.com'], remotePatterns: [{ protocol: 'https', hostname: '**.cdn.example.com' }] } };\n",
    );
    const serverDir = path.join(tmp, 'dist', 'server');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'entry.mjs'), 'export const handler = () => {};');
    fs.mkdirSync(path.join(tmp, 'dist', 'client'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('records image.domains and remotePatterns hostnames under skipImageOptimization', () => {
    const manifest = withBuildProfile({ skipImageOptimization: true }, () => astroAdapter({ projectDir: tmp, skipBuild: true }));
    assert.deepStrictEqual(manifest.imageRemoteSources, {
      domains: ['images.example.com'],
      remotePatterns: [{ protocol: 'https', hostname: '**.cdn.example.com' }],
    });
  });

  it('records a remotePattern with no hostname as any host', () => {
    fs.writeFileSync(
      path.join(tmp, 'astro.config.mjs'),
      "export default { output: 'server', image: { remotePatterns: [{ protocol: 'https' }] } };\n",
    );
    const manifest = withBuildProfile({ skipImageOptimization: true }, () => astroAdapter({ projectDir: tmp, skipBuild: true }));
    assert.deepStrictEqual(manifest.imageRemoteSources, { remotePatterns: [{ protocol: 'https', hostname: '**' }] });
  });

  it('records nothing for a build that keeps its image service', () => {
    const manifest = astroAdapter({ projectDir: tmp, skipBuild: true });
    assert.strictEqual(manifest.imageRemoteSources, undefined);
  });
});

void describe('astroAdapter — app build environment', () => {
  let tmp: string;
  let savedNodeOptions: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-adapter-build-env-'));
    savedNodeOptions = process.env.NODE_OPTIONS;
    fs.mkdirSync(path.join(tmp, 'node_modules', 'astro'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'node_modules', 'astro', 'package.json'), JSON.stringify({ name: 'astro', version: '5.0.0' }));
    fs.writeFileSync(path.join(tmp, 'astro.config.mjs'), "export default { output: 'static' };\n");
  });
  afterEach(() => {
    mock.restoreAll();
    if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedNodeOptions;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('runs the app build without the cdk condition a synth sets in NODE_OPTIONS', () => {
    let buildEnv: NodeJS.ProcessEnv | undefined;
    mock.method(spawn, 'sync', (_bin: string, _args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
      buildEnv = opts.env;
      fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<html></html>');
    });
    process.env.NODE_OPTIONS = '--conditions=cdk --max-old-space-size=4096';
    astroAdapter({ projectDir: tmp });
    assert.equal(buildEnv?.NODE_OPTIONS, '--max-old-space-size=4096');
    assert.equal(buildEnv?.PATH, process.env.PATH);
  });
});

// Only `dist/` is uploaded for the server function, without the app's
// `node_modules`. An app that names `@astrojs/node` itself must therefore be
// built with its dependencies bundled, or the server exits at start with
// ERR_MODULE_NOT_FOUND on the first bare import.
void describe('astroAdapter — build of an app that configures its own adapter', () => {
  type VitePlugin = {
    name?: string;
    apply?: 'build' | 'serve';
    config?: () => { ssr?: { noExternal?: unknown } };
  };
  type BuiltConfig = {
    output?: string;
    adapter?: unknown;
    integrations?: unknown;
    image?: unknown;
    vite: { define?: unknown; plugins: VitePlugin[]; ssr?: { external?: unknown; noExternal?: unknown } };
  };

  let tmp: string;
  /** argv of every command the adapter ran. */
  let commands: string[][];
  /** Copy of the config the build was pointed at (`--config`), if any. */
  let buildConfigCopy: string | undefined;

  const writeConfig = (adapterName: string, output = "output: 'server',"): void => {
    fs.writeFileSync(
      path.join(tmp, 'astro.config.mjs'),
      `export default {
  ${output}
  adapter: { name: '${adapterName}', hooks: {} },
  integrations: [{ name: 'user-integration', hooks: {} }],
  image: { service: { entrypoint: 'astro/assets/services/noop' } },
  vite: {
    define: { __USER__: '1' },
    plugins: [{ name: 'user-plugin' }],
    ssr: { external: ['kept-external'], noExternal: ['some-pkg'] },
  },
};
`,
    );
  };

  // Both configs are files written at run time, so they can only be loaded
  // by path.
  const loadConfigs = async (): Promise<{ built: BuiltConfig; app: BuiltConfig }> => {
    assert.ok(buildConfigCopy, 'the build must run with a config that bundles the server dependencies');
    const built: { default: BuiltConfig } = await import(pathToFileURL(buildConfigCopy).href);
    const app: { default: BuiltConfig } = await import(pathToFileURL(path.join(tmp, 'astro.config.mjs')).href);
    return { built: built.default, app: app.default };
  };

  /**
   * `ssr.noExternal` as Vite resolves it for `command`: a plugin applies to
   * its `apply` command only, and `true` from a plugin's `config` hook wins
   * over a list in the config.
   */
  const resolvedNoExternal = (vite: BuiltConfig['vite'], command: 'build' | 'serve'): unknown => {
    const fromPlugins = vite.plugins
      .filter((plugin) => plugin.apply === undefined || plugin.apply === command)
      .map((plugin) => plugin.config?.().ssr?.noExternal);
    return fromPlugins.includes(true) ? true : vite.ssr?.noExternal;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-adapter-user-adapter-'));
    fs.mkdirSync(path.join(tmp, 'node_modules', 'astro'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'node_modules', 'astro', 'package.json'),
      JSON.stringify({ name: 'astro', version: '5.0.0' }),
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'app', scripts: { build: 'astro build' } }));
    commands = [];
    buildConfigCopy = undefined;
    // Stand in for `astro build`: keep the config it was pointed at (the
    // adapter removes its own file after the build) and emit a server entry.
    mock.method(spawn, 'sync', (bin: string, args: readonly string[]) => {
      commands.push([bin, ...args]);
      const flag = args.indexOf('--config');
      if (flag !== -1) {
        // Two directories deep, like the original, so its relative import of
        // the app's config still resolves.
        const copyDir = path.join(tmp, 'node_modules', '.copy-for-test');
        fs.mkdirSync(copyDir, { recursive: true });
        buildConfigCopy = path.join(copyDir, 'build-config.mjs');
        fs.copyFileSync(path.join(tmp, args[flag + 1]), buildConfigCopy);
      }
      const serverDir = path.join(tmp, 'dist', 'server');
      fs.mkdirSync(serverDir, { recursive: true });
      fs.writeFileSync(path.join(serverDir, 'entry.mjs'), 'export const handler = () => {};');
    });
  });
  afterEach(() => {
    mock.restoreAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('bundles every dependency into the server output of an app that wires @astrojs/node', async () => {
    writeConfig('@astrojs/node');

    astroAdapter({ projectDir: tmp, skipBuild: false });

    const { built } = await loadConfigs();
    assert.strictEqual(resolvedNoExternal(built.vite, 'build'), true, 'the build leaves no dependency as a bare import');
  });

  it('bundles for the default output too, which emits a server for on-demand pages', async () => {
    writeConfig('@astrojs/node', '');

    astroAdapter({ projectDir: tmp, skipBuild: false });

    const { built } = await loadConfigs();
    assert.strictEqual(resolvedNoExternal(built.vite, 'build'), true);
    assert.strictEqual(built.output, undefined, 'the output mode stays the app\'s');
  });

  it('keeps the adapter and the rest of the config the app wrote', async () => {
    writeConfig('@astrojs/node');

    astroAdapter({ projectDir: tmp, skipBuild: false });

    const { built, app } = await loadConfigs();
    assert.strictEqual(built.adapter, app.adapter, 'the app keeps its own adapter instance');
    assert.strictEqual(built.output, 'server');
    assert.strictEqual(built.integrations, app.integrations);
    assert.strictEqual(built.image, app.image);
    assert.strictEqual(built.vite.define, app.vite.define);
    assert.deepStrictEqual(built.vite.ssr, app.vite.ssr);
    assert.strictEqual(built.vite.plugins[0], app.vite.plugins[0], 'the app\'s Vite plugins still run, first');
    // The dev server `astro build` starts to sync content collections must
    // see the app's own setting: `noExternal: true` there breaks CJS packages.
    assert.deepStrictEqual(resolvedNoExternal(built.vite, 'serve'), ['some-pkg']);
  });

  it('changes nothing in the project', () => {
    writeConfig('@astrojs/node');
    const packageJson = fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8');

    astroAdapter({ projectDir: tmp, skipBuild: false });

    assert.deepStrictEqual(
      commands.map(([bin, ...args]) => [bin, ...args.slice(0, 2)]),
      [['npm', 'run', 'build']],
      'nothing is installed: the app already has its adapter',
    );
    assert.deepStrictEqual(
      fs.readdirSync(tmp).sort(),
      ['astro.config.mjs', 'dist', 'node_modules', 'package.json'],
      'the build-only config is removed after the build',
    );
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'), packageJson);
  });

  it('builds an app that wires another adapter from its own config, as before', () => {
    writeConfig('@example/other-adapter');

    astroAdapter({ projectDir: tmp, skipBuild: false });

    assert.deepStrictEqual(commands, [['npm', 'run', 'build']]);
  });
});
