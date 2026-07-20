/**
 * SvelteKit adapter — works for any SvelteKit 2 project.
 *
 * SvelteKit ships no AWS target of its own, but its official
 * `@sveltejs/adapter-node` emits a standard Node HTTP server (`node build`)
 * that serves SSR pages, `+server.js` endpoints, form actions, server
 * `load`, `hooks.server`, prerendered pages, and static assets. We run that
 * server on Lambda through the existing `http-server` compute type fronted by
 * the Lambda Web Adapter (LWA) — the same path the Astro (`@astrojs/node`
 * standalone) and Nitro `node-server` adapters use.
 *
 * The L3 construct never knows the project is SvelteKit — it sees an
 * `http-server` compute resource, route patterns, and a static-assets dir.
 *
 * Transparent build: SvelteKit has no `--config` build flag (unlike Astro), so
 * when the user hasn't wired `@sveltejs/adapter-node` themselves the adapter
 * temporarily swaps `svelte.config.js` for a bridged config that imports the
 * user's original and force-sets `kit.adapter = node({ out: 'build' })`, builds,
 * then restores the original in a `finally`. When the user already configured
 * `@sveltejs/adapter-node`, the bridge is skipped and the build runs as-is.
 *
 * Inputs read from the project after build (`build/` — adapter-node's default
 * `out`):
 *   - `build/index.js`      — the server entry (`node index.js`)
 *   - `build/client/`       — hashed assets (`_app/immutable/*`) + `static/`
 *   - `build/prerendered/`  — prerendered HTML pages
 *   - `build/server/`       — the SSR bundle
 */
import { spawn } from './spawn.js';
import { normalizeBasePath } from './shared/basepath.js';
import { warnIfVercelCron } from './shared/feature_warnings.js';
import * as fs from 'fs';
import * as path from 'path';
import fg from 'fast-glob';
import semver from 'semver';
import { createJiti } from 'jiti';
import { getPackageInfoSync } from 'local-pkg';
import { HostingError } from '../hosting_error.js';
import type {
  ComputeResource,
  DeployManifest,
  RouteBehavior,
} from '../manifest/types.js';

export type SveltekitAdapterOptions = {
  /** Project root directory (absolute). */
  projectDir: string;
  /**
   * Skip running the build command. Useful for tests and when the caller has
   * already produced `build/`.
   */
  skipBuild?: boolean;
  /**
   * Override the build command. Defaults to `npm run build` when the user's
   * `package.json` defines a `build` script, falling back to `npx vite build`.
   */
  buildCommand?: string[];
  /**
   * Maximum request body size (bytes) the SvelteKit server will accept before
   * rejecting with 413. Default: 20 MB — matches the Astro adapter and the
   * Lambda Function URL response-stream ceiling. Forwarded to adapter-node's
   * `BODY_SIZE_LIMIT` env var (adapter-node's own default is only 512 KB, which
   * silently 413s file uploads).
   */
  bodySizeLimit?: number;
};

/** 20 MB — matches the Astro adapter's default body-size ceiling. */
const DEFAULT_BODY_SIZE_LIMIT_BYTES = 20 * 1024 * 1024;

/** SSR Lambda port (the adapter-node server reads `PORT`; LWA sets it too). */
const SVELTEKIT_SERVER_PORT = 3000;

/** Pinned to match SvelteKit 2's peer-dep. Bump in lockstep on adapter majors. */
const ADAPTER_NODE_PIN = '@sveltejs/adapter-node@^5';

/**
 * Verified SvelteKit version range. Exported for the X.1 cross-adapter
 * version-pin test that asserts CI doesn't ship with the adapters outside their
 * verified ranges.
 *
 * "Verified" means **believed compatible** (the adapter's assumptions about the
 * `build/` layout — `index.js`, `client/`, `prerendered/`, `server/` — and the
 * `@sveltejs/adapter-node` bridge hold across this range), NOT "actively tested
 * against every release." The runtime hard floor (`< 2.0` rejected) is enforced
 * separately by `assertSvelteKitVersion`. Bump the upper bound only after
 * confirming a new major actually works.
 */
export const VERIFIED_SVELTEKIT_RANGE = '>=2.0.0 <3.0.0';

/**
 * Lambda Web Adapter exec wrapper. The LWA's `/opt/bootstrap` runs `$_HANDLER`
 * as a child process — without a `node` shebang, bash would parse `index.js` as
 * shell, so we wrap in `run.sh`. Mirrors the Astro adapter's wrapper.
 */
const RUN_SH_FILENAME = 'run.sh';
const RUN_SH_SOURCE = `#!/bin/sh
cd "$(dirname "$0")"
if [ -x /var/lang/bin/node ]; then
  exec /var/lang/bin/node index.js
fi
exec node index.js
`;

const SVELTE_CONFIG_FILES = [
  'svelte.config.js',
  'svelte.config.mjs',
  'svelte.config.ts',
];

/**
 * Basename (without extension) the transparent bridge parks the user's original
 * config under while the bridged config takes the original's slot. The original
 * file's extension is preserved (`svelte.config.blocks-original.mjs` for an
 * `.mjs` source) so strict ESM/TS loaders resolve the parked module the same
 * way they would the original.
 */
const BRIDGE_BACKUP_BASENAME = 'svelte.config.blocks-original';

/**
 * Run the SvelteKit adapter pipeline.
 * @param options - adapter configuration
 * @returns the generated DeployManifest
 */
export const sveltekitAdapter = (
  options: SveltekitAdapterOptions,
): DeployManifest => {
  const { projectDir, skipBuild, buildCommand } = options;
  const bodySizeLimit = options.bodySizeLimit ?? DEFAULT_BODY_SIZE_LIMIT_BYTES;

  assertSvelteKitVersion(projectDir);

  if (!skipBuild) {
    // Refuse to run when the user has wired an adapter that ISN'T
    // adapter-node (e.g. adapter-cloudflare, adapter-static, adapter-auto).
    // Silently swapping it for adapter-node would discard a deliberate
    // deployment-target choice — fail loudly instead so the user decides.
    assertNoIncompatibleAdapter(projectDir);

    // Bridge-decision: only skip the bridge when the user has WIRED
    // adapter-node in their svelte.config (a text scan for the import). A bare
    // node_modules presence is unreliable — adapter-node can land there
    // transitively — so we key off the config text, the same signal Astro's
    // adapter uses for its bridge decision.
    const useBridge = !svelteConfigUsesAdapterNode(projectDir);
    let cleanupBridge: (() => void) | undefined;
    if (useBridge) {
      cleanupBridge = installSvelteKitBridge(projectDir);
    } else {
      process.stderr.write(
        '✨ Detected @sveltejs/adapter-node in svelte.config; building as-is.\n',
      );
    }
    try {
      runSvelteKitBuild(projectDir, buildCommand);
    } finally {
      cleanupBridge?.();
    }
  }

  const buildDir = path.join(projectDir, 'build');
  const clientDir = path.join(buildDir, 'client');
  const prerenderedDir = path.join(buildDir, 'prerendered');
  const serverEntry = path.join(buildDir, 'index.js');

  if (!fs.existsSync(serverEntry)) {
    throw new HostingError('SvelteKitBuildOutputMissingError', {
      message: `SvelteKit adapter-node output is missing at ${serverEntry}.`,
      resolution:
        'Ensure the build succeeded with @sveltejs/adapter-node (out: "build"). ' +
        'Run `npm run build` and confirm `build/index.js` and `build/client/` exist. ' +
        'If you use a different adapter, switch to @sveltejs/adapter-node or let ' +
        'the hosting adapter install it for you.',
    });
  }
  if (!directoryHasFiles(clientDir)) {
    throw new HostingError('SvelteKitBuildOutputMissingError', {
      message: `SvelteKit client assets are missing or empty at ${clientDir}.`,
      resolution:
        'The build did not emit client assets. Confirm `@sveltejs/adapter-node` ' +
        'produced `build/client/` and that the build completed without errors.',
    });
  }

  // Warn (don't fail) when a vercel.json declares crons — parity with the
  // other adapters; the hosting architecture wires no scheduler.
  warnIfVercelCron(projectDir);

  const config = loadSvelteConfig(projectDir);
  const appDir = readAppDir(config);
  const basePath = normalizeBasePath(readBasePath(config));

  // Merge prerendered pages into the S3-served client dir so every static
  // object lives under one uploaded directory. adapter-node keeps its own copy
  // under build/prerendered/ for the Lambda catch-all, so this is additive.
  mergePrerenderedIntoClient(prerenderedDir, clientDir);

  // adapter-node's `precompress` defaults to true → it writes `.gz`/`.br`
  // siblings. Strip them: CloudFront re-compresses on the edge based on
  // Accept-Encoding, and shipping the pre-compressed copies bypasses that
  // negotiation. Same rationale as the Astro/Nitro adapters.
  prunePreCompressedAssets(clientDir);

  // LWA runs `run.sh`, which execs `node index.js` from the bundle root.
  writeRunShWrapper(buildDir);

  const manifest = buildManifest({
    buildDir,
    clientDir,
    prerenderedDir,
    appDir,
    bodySizeLimit,
  });

  if (basePath) {
    manifest.basePath = basePath;
    process.stdout.write(
      `🔗 Detected SvelteKit paths.base=${basePath}; CloudFront behaviors will be prefixed.\n`,
    );
  }

  return manifest;
};

// ---- version guard ----

const assertSvelteKitVersion = (projectDir: string): void => {
  const info = getPackageInfoSync('@sveltejs/kit', { paths: [projectDir] });
  const version = info?.version;
  // Enforce the FULL verified range — both the floor (< 2.0 rejected) and the
  // upper bound. A new major (e.g. 3.x) can silently change the adapter-node
  // `build/` layout the manifest builder depends on, so we refuse it until the
  // range is deliberately bumped after re-verification. `satisfies` honors the
  // `<` bound the version_pins.test.ts asserts on.
  if (!version || !semver.satisfies(version, VERIFIED_SVELTEKIT_RANGE)) {
    throw new HostingError('UnsupportedSvelteKitVersionError', {
      message: `SvelteKit version ${
        version ?? '(not installed)'
      } is outside the verified range ${VERIFIED_SVELTEKIT_RANGE}.`,
      resolution:
        'Install a SvelteKit version within the verified range (e.g. ' +
        '`npm install @sveltejs/kit@2`, or your package manager equivalent). ' +
        'If you are on SvelteKit 1.x, follow the SvelteKit 2 migration guide at ' +
        'https://svelte.dev/docs/kit/migrating-to-sveltekit-2. If you are on a ' +
        'newer major, the adapter has not yet been verified against it.',
    });
  }
};

// ---- transparent bridge ----

const findSvelteConfigPath = (projectDir: string): string | undefined =>
  SVELTE_CONFIG_FILES.map((f) => path.join(projectDir, f)).find((p) =>
    fs.existsSync(p),
  );

/**
 * True when a `svelte.config.*` text references `@sveltejs/adapter-node`. A
 * text scan (not module load) so it works before the dep is installed and
 * without evaluating the config's adapter imports.
 */
const svelteConfigUsesAdapterNode = (projectDir: string): boolean => {
  const configPath = findSvelteConfigPath(projectDir);
  if (!configPath) return false;
  try {
    const src = fs.readFileSync(configPath, 'utf-8');
    return /@sveltejs\/adapter-node/.test(src);
  } catch {
    return false;
  }
};

/**
 * Throw when the `svelte.config.*` wires an official SvelteKit adapter that is
 * NOT `@sveltejs/adapter-node`. The bridge only knows how to force adapter-node;
 * running it against, say, `@sveltejs/adapter-cloudflare` or
 * `@sveltejs/adapter-static` would silently overwrite a deliberate
 * deployment-target choice (the only signal being a stderr line emitted inside
 * the build subprocess, after the swap has already happened). A text scan (not
 * a module load) so it works before deps are installed and without evaluating
 * the config's adapter imports. adapter-node itself, or no adapter at all,
 * passes through to the normal bridge decision.
 */
const assertNoIncompatibleAdapter = (projectDir: string): void => {
  const configPath = findSvelteConfigPath(projectDir);
  if (!configPath) return;
  let src = '';
  try {
    src = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return;
  }
  const referencesAnyAdapter = /@sveltejs\/adapter-/.test(src);
  if (referencesAnyAdapter && !svelteConfigUsesAdapterNode(projectDir)) {
    throw new HostingError('SvelteKitIncompatibleAdapterError', {
      message: `Your ${path.basename(
        configPath,
      )} wires a SvelteKit adapter that is incompatible with Lambda-backed hosting (only @sveltejs/adapter-node is supported).`,
      resolution:
        'Switch to @sveltejs/adapter-node in your svelte.config, or remove the ' +
        'adapter entirely and let the hosting adapter install and wire ' +
        '@sveltejs/adapter-node for you.',
    });
  }
};

/**
 * Swap the user's `svelte.config.js` for a bridged config that force-selects
 * `@sveltejs/adapter-node` while preserving every other user setting (spreads
 * the original config + its `kit` block). Returns a cleanup function that
 * restores the original config; always call it in a `finally`.
 *
 * Installs `@sveltejs/adapter-node` (pinned) via the detected package manager
 * when it isn't present, saving it to package.json so CI rebuilds reproduce.
 */
const installSvelteKitBridge = (projectDir: string): (() => void) => {
  const userConfigPath = findSvelteConfigPath(projectDir);
  if (!userConfigPath) {
    throw new HostingError('SvelteKitConfigNotFoundError', {
      message: `No svelte.config.{js,mjs,ts} found in ${projectDir}.`,
      resolution:
        'Add a svelte.config.js at the project root, or install ' +
        '@sveltejs/adapter-node yourself and wire it in your svelte.config.',
    });
  }

  const configName = path.basename(userConfigPath);
  // Preserve the original config's extension so the parked module resolves the
  // same way the original did (an `.mjs`/`.ts` source keeps its loader
  // semantics rather than being renamed to `.js`).
  const backupExt = path.extname(userConfigPath) || '.js';
  const backupFile = `${BRIDGE_BACKUP_BASENAME}${backupExt}`;
  const backupPath = path.join(projectDir, backupFile);
  // Guard against a stale backup from a previous crashed run clobbering the
  // real config. Checked BEFORE any mutation (the install below writes to
  // package.json / node_modules) so a collision aborts cleanly, touching
  // nothing.
  if (fs.existsSync(backupPath)) {
    throw new HostingError('SvelteKitBridgeCollisionError', {
      message: `A leftover bridge backup already exists at ${backupPath}.`,
      resolution: `Restore your original svelte config: rename ${backupFile} back to ${configName} and delete the generated ${configName}, then re-run the deploy.`,
    });
  }

  installAdapterNode(projectDir);

  // Park the original config under its preserved name (so the bridge can import
  // it), then write the bridge into the original config's slot.
  fs.renameSync(userConfigPath, backupPath);
  fs.writeFileSync(
    userConfigPath,
    buildBridgeConfigSource(backupFile),
    'utf-8',
  );
  process.stderr.write('✨ Installed SvelteKit bridge (transparent build)\n');

  return (): void => {
    try {
      // Restore: remove the generated bridge, move the original back.
      if (fs.existsSync(userConfigPath)) fs.rmSync(userConfigPath);
      if (fs.existsSync(backupPath)) fs.renameSync(backupPath, userConfigPath);
    } catch {
      // Best-effort. A leftover backup surfaces loudly on the next run via the
      // collision guard above, so we never silently overwrite the user config.
    }
  };
};

const buildBridgeConfigSource = (
  originalConfigFile: string,
): string => `import userConfig from './${originalConfigFile}';
import node from '@sveltejs/adapter-node';

const kit = userConfig.kit ?? {};

if (kit.adapter) {
  process.stderr.write(
    '[hosting:sveltekit] replacing configured adapter with @sveltejs/adapter-node (out: "build").\\n',
  );
}

export default {
  ...userConfig,
  kit: {
    ...kit,
    adapter: node({ out: 'build' }),
  },
};
`;

/**
 * Detect the package manager from a lockfile and return the install command for
 * a package spec. Mirrors the Astro adapter's detection: pnpm/yarn/bun
 * lockfiles can't be touched by `npm install` without corruption.
 */
const detectPackageManagerInstall = (
  projectDir: string,
  packageSpec: string,
): { command: string; args: string[] } => {
  const has = (file: string): boolean =>
    fs.existsSync(path.join(projectDir, file));
  // @sveltejs/adapter-node is a dev dependency in every SvelteKit project, so
  // each manager's dev flag is passed (npm below uses --save-dev). Without it
  // pnpm/yarn/bun would add it to `dependencies`.
  if (has('pnpm-lock.yaml')) {
    return { command: 'pnpm', args: ['add', '-D', '--silent', packageSpec] };
  }
  if (has('yarn.lock')) {
    return { command: 'yarn', args: ['add', '--dev', '--silent', packageSpec] };
  }
  if (has('bun.lockb') || has('bun.lock')) {
    return { command: 'bun', args: ['add', '-d', packageSpec] };
  }
  return {
    command: 'npm',
    args: [
      'install',
      '--save-dev',
      '--no-audit',
      '--no-fund',
      '--silent',
      packageSpec,
    ],
  };
};

const installAdapterNode = (projectDir: string): void => {
  // Idempotent: skip if adapter-node is already resolvable from the project.
  if (getPackageInfoSync('@sveltejs/adapter-node', { paths: [projectDir] })) {
    return;
  }
  const install = detectPackageManagerInstall(projectDir, ADAPTER_NODE_PIN);
  process.stderr.write(
    `\u{1F4E6} Installing ${ADAPTER_NODE_PIN} via ${install.command} ` +
      `(saved to package.json — commit the change so CI rebuilds reproduce)\n`,
  );
  try {
    spawn.sync(install.command, install.args, {
      cwd: projectDir,
      stdio: 'inherit',
    });
  } catch (error) {
    throw new HostingError(
      'SvelteKitAdapterInstallError',
      {
        message:
          'Failed to install @sveltejs/adapter-node — required for the SvelteKit SSR bridge.',
        resolution:
          `Try \`${install.command} ${install.args.join(' ')}\` in your project to diagnose, ` +
          'or pin @sveltejs/adapter-node yourself in package.json and re-run.',
      },
      error as Error,
    );
  }
};

// ---- build ----

const projectHasBuildScript = (projectDir: string): boolean => {
  const pkgPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    return Boolean(pkg.scripts?.build);
  } catch {
    return false;
  }
};

const runSvelteKitBuild = (
  projectDir: string,
  buildCommand: string[] | undefined,
): void => {
  const cmd =
    buildCommand && buildCommand.length > 0
      ? buildCommand
      : projectHasBuildScript(projectDir)
        ? ['npm', 'run', 'build']
        : ['npx', 'vite', 'build'];

  process.stderr.write(`\u{1F528} Running SvelteKit build: ${cmd.join(' ')}\n`);
  try {
    const [bin, ...args] = cmd;
    spawn.sync(bin!, args, { cwd: projectDir, stdio: 'inherit' });
  } catch (error) {
    throw new HostingError(
      'SvelteKitBuildError',
      {
        message: 'SvelteKit build failed.',
        resolution:
          'Check the build output above. Common causes:\n' +
          '  - Missing dependencies (run: npm install)\n' +
          '  - Invalid svelte.config.js\n' +
          '  - TypeScript / Svelte compile errors in your routes or components\n' +
          '  - A route that cannot be prerendered but is marked `prerender = true`',
      },
      error as Error,
    );
  }
};

// ---- config reading (best-effort) ----

type SvelteConfigShape = {
  kit?: {
    appDir?: string;
    paths?: { base?: string };
  };
};

/**
 * Load the resolved svelte config via jiti (best-effort). Used only to read
 * `kit.appDir` and `kit.paths.base` — a failure falls back to a text scan and,
 * ultimately, safe defaults, so a config that jiti can't evaluate never blocks
 * the deploy.
 */
const loadSvelteConfig = (projectDir: string): SvelteConfigShape => {
  const configPath = findSvelteConfigPath(projectDir);
  if (!configPath) return {};
  try {
    const jiti = createJiti(projectDir, { interopDefault: true });
    const mod = jiti(configPath) as
      | SvelteConfigShape
      | { default?: SvelteConfigShape };
    const config =
      mod && typeof mod === 'object' && 'default' in mod && mod.default
        ? (mod.default as SvelteConfigShape)
        : (mod as SvelteConfigShape);
    return config ?? {};
  } catch {
    // Fall back to a text scan for the two fields we need.
    return textScanSvelteConfig(configPath);
  }
};

/**
 * Minimal text scan for `kit.appDir` / `kit.paths.base` when jiti can't
 * evaluate the config (e.g. it imports an adapter that throws at load).
 */
const textScanSvelteConfig = (configPath: string): SvelteConfigShape => {
  let src = '';
  try {
    src = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return {};
  }
  const out: SvelteConfigShape = { kit: {} };
  const appDir = src.match(/\bappDir\s*:\s*['"`]([^'"`]+)['"`]/);
  if (appDir) out.kit!.appDir = appDir[1];
  const base = src.match(/\bbase\s*:\s*['"`]([^'"`]*)['"`]/);
  if (base) out.kit!.paths = { base: base[1] };
  return out;
};

/** SvelteKit's default `appDir` is `_app`. */
const readAppDir = (config: SvelteConfigShape): string => {
  const appDir = config.kit?.appDir;
  return typeof appDir === 'string' && appDir.length > 0 ? appDir : '_app';
};

const readBasePath = (config: SvelteConfigShape): string | undefined => {
  const base = config.kit?.paths?.base;
  return typeof base === 'string' ? base : undefined;
};

// ---- filesystem helpers ----

const directoryHasFiles = (dir: string): boolean => {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).length > 0;
};

/** Error-page basenames kept flat (CloudFront errorResponses reference `/404.html`). */
const FLAT_HTML_NAMES = new Set(['404.html', '500.html']);

/**
 * Copy prerendered pages/assets into the S3-served client dir so they upload as
 * static objects, NORMALIZING flat HTML files into directory-index form.
 *
 * Why the normalization: SvelteKit's default `trailingSlash: 'never'` writes a
 * prerendered `/about` as a FLAT `about.html`. But the L3 KVS router resolves a
 * bare extensionless request (`/about`) by appending `/index.html` (directory
 * index) → it looks up `about/index.html` on S3. Without this transform S3 has
 * only `about.html`, so `/about` 404s (NoSuchKey). Nuxt/Astro emit
 * directory-style output natively; SvelteKit doesn't, so we bridge it here:
 *
 *   about.html        → about/index.html
 *   blog/post.html    → blog/post/index.html
 *   index.html (root) → index.html      (unchanged — the catch-all serves `/`)
 *   404.html/500.html → unchanged       (CloudFront error pages)
 *   <non-html assets> → unchanged       (e.g. prerendered __data.json)
 *
 * adapter-node keeps its own copy under build/prerendered/ for the Lambda
 * catch-all, so this only adds to the S3 side. Existing files in client/ (real
 * assets) are never overwritten.
 */
const mergePrerenderedIntoClient = (
  prerenderedDir: string,
  clientDir: string,
): void => {
  if (!fs.existsSync(prerenderedDir)) return;
  const files = fg.sync('**/*', {
    cwd: prerenderedDir,
    onlyFiles: true,
    dot: true,
  });
  for (const rel of files) {
    const src = path.join(prerenderedDir, rel);
    const dest = path.join(clientDir, prerenderedDestRelPath(rel));
    if (fs.existsSync(dest)) continue; // never clobber a real client asset
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
};

/**
 * Map a prerendered file's relative path to its destination under client/,
 * converting a flat `<name>.html` into `<name>/index.html` (directory index).
 * Leaves root `index.html`, error pages, already-directory-index files, and
 * non-HTML assets unchanged.
 * @internal
 */
export const prerenderedDestRelPath = (rel: string): string => {
  const normalized = rel.replace(/\\/g, '/');
  const base = normalized.split('/').pop() ?? normalized;
  // Non-HTML asset, root index, an already-index file, or an error page → as-is.
  if (
    !base.endsWith('.html') ||
    base === 'index.html' ||
    FLAT_HTML_NAMES.has(base)
  ) {
    return normalized;
  }
  // `about.html` → `about/index.html`; `blog/post.html` → `blog/post/index.html`.
  return normalized.replace(/\.html$/, '/index.html');
};

/**
 * Remove pre-compressed sibling files (`*.gz`, `*.br`, `*.zst`) so they aren't
 * uploaded to S3. CloudFront's `compress: true` re-compresses on the edge based
 * on `Accept-Encoding`.
 */
const prunePreCompressedAssets = (dir: string): void => {
  if (!fs.existsSync(dir)) return;
  const compressed = fg.sync('**/*.{gz,br,zst}', {
    cwd: dir,
    absolute: true,
    caseSensitiveMatch: false,
  });
  for (const f of compressed) fs.rmSync(f);
};

const writeRunShWrapper = (buildDir: string): void => {
  const dest = path.join(buildDir, RUN_SH_FILENAME);
  fs.writeFileSync(dest, RUN_SH_SOURCE, { encoding: 'utf-8', mode: 0o755 });
};

// ---- manifest ----

const buildManifest = (input: {
  buildDir: string;
  clientDir: string;
  prerenderedDir: string;
  appDir: string;
  bodySizeLimit: number;
}): DeployManifest => {
  const { buildDir, clientDir, prerenderedDir, appDir, bodySizeLimit } = input;

  const compute: Record<string, ComputeResource> = {
    default: {
      // bundle: build/ (whole tree) — index.js lives at the root and the
      // adapter-node server resolves client/ + prerendered/ relative to it.
      type: 'http-server',
      bundle: buildDir,
      entrypoint: RUN_SH_FILENAME,
      port: SVELTEKIT_SERVER_PORT,
      placement: 'regional',
      runtime: 'nodejs20.x',
      /* eslint-disable @typescript-eslint/naming-convention */
      environment: {
        // Behind CloudFront the SSR server must reconstruct the public origin
        // from proxy headers so redirects / form-action URLs / cookies point
        // at the viewer domain, not the raw Lambda host. The KVS router copies
        // Host → x-forwarded-host on compute-bound requests.
        HOST_HEADER: 'x-forwarded-host',
        PROTOCOL_HEADER: 'x-forwarded-proto',
        // adapter-node's default is 512 KB, which silently 413s file uploads.
        BODY_SIZE_LIMIT: String(bodySizeLimit),
      },
      /* eslint-enable @typescript-eslint/naming-convention */
    },
  };

  const manifest: DeployManifest = {
    version: 1,
    compute,
    staticAssets: {
      directory: clientDir,
      // SvelteKit content-hashes everything under `${appDir}/immutable/`; the
      // rest of client/ (static/ files, prerendered HTML) must NOT be immutable.
      immutablePaths: [`${appDir}/immutable/*`],
    },
    routes: buildRoutes(clientDir, prerenderedDir, appDir),
  };

  const errorPages = detectErrorPages(clientDir);
  if (Object.keys(errorPages).length > 0) {
    manifest.errorPages = errorPages;
  }

  return manifest;
};

/**
 * Emit static (S3) routes for the hashed asset dir, every top-level client
 * entry, and each prerendered page, then a catch-all `/* → default` (SSR) last.
 */
const buildRoutes = (
  clientDir: string,
  prerenderedDir: string,
  appDir: string,
): RouteBehavior[] => {
  const routes: RouteBehavior[] = [];
  const seen = new Set<string>();
  const add = (route: RouteBehavior): void => {
    if (seen.has(route.pattern)) return;
    routes.push(route);
    seen.add(route.pattern);
  };

  // Hashed immutable assets first — always route to S3.
  add({ pattern: `/${appDir}/*`, target: 'static' });

  // Every other top-level entry in client/ is a static asset (favicon.png,
  // robots.txt, user `static/` files, and any framework dir).
  if (fs.existsSync(clientDir)) {
    for (const entry of fs.readdirSync(clientDir, { withFileTypes: true })) {
      if (entry.name === appDir) continue; // handled above
      // Skip prerendered HTML index files — handled as page routes below.
      if (entry.isFile() && entry.name.endsWith('.html')) continue;
      const pattern = entry.isDirectory()
        ? `/${entry.name}/*`
        : `/${entry.name}`;
      add({ pattern, target: 'static' });
    }
  }

  // Prerendered pages → S3. Emit BOTH the bare route and its subtree so both
  // `/about` and prefetch siblings (`/about/__data.json`) resolve from S3. The
  // router's directory-index rewrite maps the bare extensionless path to its
  // `index.html`. Mirrors the Nitro / Astro adapters.
  for (const htmlFile of walkHtmlFiles(prerenderedDir)) {
    const rel = path.relative(prerenderedDir, htmlFile).replace(/\\/g, '/');
    const urlPath = htmlFileToUrlPath(rel);
    if (urlPath === '/') {
      // A prerendered root is copied into client/ as index.html, so serve it
      // from S3 rather than letting every homepage request fall through to the
      // catch-all SSR Lambda. The bare `/` static route precedes the `/*`
      // catch-all added below; deeper paths still reach SSR via `/*`.
      add({ pattern: '/', target: 'static' });
      continue;
    }
    add({ pattern: urlPath, target: 'static' });
    add({ pattern: `${urlPath}/*`, target: 'static' });
  }

  // Catch-all SSR route always last.
  add({ pattern: '/*', target: 'default' });

  return routes;
};

const walkHtmlFiles = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  return fg.sync('**/*.html', { cwd: dir, absolute: true });
};

/**
 * Convert a relative `.html` path into a CloudFront route pattern.
 * `about.html` → `/about`; `about/index.html` → `/about`; `index.html` → `/`.
 */
const htmlFileToUrlPath = (relPath: string): string => {
  let urlPath = '/' + relPath.replace(/\\/g, '/').replace(/\.html$/, '');
  urlPath = urlPath.replace(/\/index$/, '');
  return urlPath === '' ? '/' : urlPath;
};

const detectErrorPages = (
  staticDir: string,
): Partial<Record<404 | 500, string>> => {
  const out: Partial<Record<404 | 500, string>> = {};
  if (fs.existsSync(path.join(staticDir, '404.html'))) {
    out[404] = '/404.html';
  }
  if (fs.existsSync(path.join(staticDir, '500.html'))) {
    out[500] = '/500.html';
  }
  return out;
};
