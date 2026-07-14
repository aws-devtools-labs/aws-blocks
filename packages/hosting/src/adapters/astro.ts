/**
 * Astro adapter — works for any Astro 4+ project (`output: 'static' |
 * 'server' | 'hybrid'`). Reads the user's `astro.config.{ts,mjs,js}`
 * with jiti (no source-text scanning), inspects the post-build `dist/`
 * tree, and emits a framework-agnostic DeployManifest.
 *
 * The L3 construct never knows the project is Astro — it sees compute
 * resources, route patterns, and static-asset directories.
 *
 * Inputs read from the project:
 *   - `package.json`          → astro version (≥ 4.0)
 *   - `astro.config.{ts,mjs,js}` → output mode, trailingSlash, image config
 *   - `dist/`                 → static-only output
 *   - `dist/client/` + `dist/server/entry.mjs` → server / hybrid output
 *
 * SSR runtime: server / hybrid builds run via the Lambda Web Adapter
 * fronting `@astrojs/node`'s standalone HTTP server. The L3 attaches
 * the LWA layer for `compute.type === 'http-server'` automatically.
 *
 * Transparent build: when the user has not wired `@astrojs/node`
 * themselves, the adapter materialises a hidden config-bridge that
 * imports the user's config and force-merges `output: 'server'` +
 * `adapter: node({ mode: 'standalone' })`. The bridge is removed after
 * build (success or failure). When the user already configured
 * `@astrojs/node`, the bridge is skipped.
 */
import { spawn } from './spawn.js';
import { normalizeBasePath } from './shared/basepath.js';
import { emitTrailingSlashRedirects } from './shared/trailing_slash.js';
import { warnIfVercelCron } from './shared/feature_warnings.js';
import * as fs from 'fs';
import * as path from 'path';
import fg from 'fast-glob';
import semver from 'semver';
import { createJiti } from 'jiti';
import { getPackageInfoSync, isPackageExists } from 'local-pkg';
import { HostingError } from '../hosting_error.js';
import { DeployManifest, Redirect, RouteBehavior } from '../manifest/types.js';

export type AstroAdapterOptions = {
  /** Project root directory (absolute). */
  projectDir: string;
  /**
   * Skip running the build command. Useful for tests and when the
   * caller has already produced `dist/`.
   */
  skipBuild?: boolean;
  /**
   * Override the build command. Defaults to `npm run build` when the
   * user's `package.json` defines a `build` script, falling back to
   * `npx astro build`.
   */
  buildCommand?: string[];
  /**
   * Maximum request body size (bytes) Astro will accept before throwing.
   * Default: 20 MB — matches Lambda Function URL's response-stream
   * payload ceiling. Set to `Infinity` or `0` to opt out (not
   * recommended; oversized requests then fail mid-stream at the
   * platform boundary instead of with a clean 413).
   */
  bodySizeLimit?: number;
};

/** 20 MB — Lambda Function URL response-stream payload ceiling. */
const DEFAULT_BODY_SIZE_LIMIT_BYTES = 20 * 1024 * 1024;

/** SSR Lambda port (the standalone server reads `PORT` env). */
const ASTRO_SERVER_PORT = 3000;

/** Bridge files live here, hidden from the user. */
const BRIDGE_DIR_REL = path.posix.join('.hosting', 'astro');
const BRIDGE_CONFIG_FILE = 'config-bridge.mjs';

/** Pinned to match astro@^5/^6 peer-dep. Bump in lockstep on Astro majors. */
const ASTROJS_NODE_PIN = '@astrojs/node@^9';

/**
 * `sharp` version installed into the SSR bundle for Astro's default image
 * service (`/_image`). Matches the range the IPX image-opt bundle uses so
 * both image paths ship the same native libvips. See installSharpForAstroSsr.
 */
const ASTRO_SHARP_VERSION = '^0.34.0';

/**
 * Verified Astro version range. Exported for the X.1 cross-adapter
 * version-pin test that asserts CI doesn't ship with the adapters
 * outside their verified ranges.
 *
 * "Verified" here means **believed compatible** (the adapter's
 * assumptions about `dist/` layout and the `@astrojs/node` bridge hold
 * across this range), NOT "actively tested against every release in
 * the range." We exercise the current major + the previous one; the
 * upper bound is the next major we have NOT validated. Bump it only
 * after confirming a new major actually works — widening it
 * speculatively (e.g. `<7.0.0` while 6.x doesn't even exist yet) makes
 * the documented compatibility claim wider than what we've checked.
 *
 * Note this constant is advisory: the runtime hard floor is enforced
 * separately by `assertAstroVersion` (rejects < 4.0). This range is
 * consumed by the X.1 cross-adapter version-pin test, which asserts it
 * stays a parseable range with an explicit upper bound.
 */
export const VERIFIED_ASTRO_RANGE = '>=4.0.0 <6.0.0';

/**
 * Lambda Web Adapter exec wrapper. The LWA's `/opt/bootstrap` runs
 * `$_HANDLER` as a child process — without a `node` shebang, bash
 * would parse `entry.mjs` as shell, so we wrap in `run.sh`.
 */
const RUN_SH_FILENAME = 'run.sh';
const RUN_SH_SOURCE = `#!/bin/sh
cd "$(dirname "$0")"
if [ -x /var/lang/bin/node ]; then
  exec /var/lang/bin/node entry.mjs
fi
exec node entry.mjs
`;

/**
 * Run the Astro adapter pipeline.
 * @param options - adapter configuration
 * @returns the generated DeployManifest
 */
export const astroAdapter = (options: AstroAdapterOptions): DeployManifest => {
  const { projectDir, skipBuild, buildCommand } = options;
  const bodySizeLimit = options.bodySizeLimit ?? DEFAULT_BODY_SIZE_LIMIT_BYTES;

  assertAstroVersion(projectDir);

  // Load the user's config BEFORE the build — we need the output mode
  // to decide whether the bridge should run, and so the post-build
  // probes know which directory shape to expect.
  const config = loadAstroConfig(projectDir);
  const userOutput: AstroOutput =
    (config.output as AstroOutput | undefined) ?? 'static';
  const trailingSlash: AstroTrailingSlash =
    (config.trailingSlash as AstroTrailingSlash | undefined) ?? 'ignore';
  const liftedRedirects = liftAstroRedirects(config);
  const basePath = normalizeBasePath(
    typeof config.base === 'string' ? config.base : undefined,
  );

  if (!skipBuild) {
    // Bridge-decision: only honor a user adapter when it's wired in
    // astro.config (`adapter:` field). Checking `node_modules` alone is
    // unreliable — `@astrojs/node` can land there from a prior install
    // or as a transitive dep, and trusting that signal silently skips
    // the bridge on configs that have no adapter wired, producing the
    // canonical `[NoAdapterInstalled]` build crash.
    const userConfiguredAdapter = config.adapter !== undefined;
    const useBridge = userOutput !== 'static' && !userConfiguredAdapter;
    let cleanupBridge: (() => void) | undefined;
    if (useBridge) {
      cleanupBridge = installAstroBridge(projectDir, bodySizeLimit);
    } else if (userOutput !== 'static') {
      process.stderr.write(
        '✨ Detected user-configured adapter in astro.config; using user config as-is.\n',
      );
    }
    try {
      runAstroBuild(projectDir, buildCommand, useBridge);
    } finally {
      cleanupBridge?.();
    }
  }

  // Final output mode: trust the user's astro.config. If they declared
  // server/hybrid, the build MUST produce dist/server/entry.mjs — even
  // if the bridge wasn't used (because they wired @astrojs/node
  // themselves and broke it, or skipBuild was set incorrectly).
  // Static-only configs may still get a server bundle if the bridge
  // ran (skipBuild=false), but downgrading from server→static would
  // hide configuration mistakes; keep the user's declared mode.
  const distDir = path.join(projectDir, 'dist');
  const clientDir = path.join(distDir, 'client');
  const serverDir = path.join(distDir, 'server');
  const serverEntry = path.join(serverDir, 'entry.mjs');
  const output: AstroOutput =
    userOutput === 'static' && fs.existsSync(serverEntry)
      ? 'server'
      : userOutput;

  if (output === 'static') {
    if (!directoryHasFiles(distDir)) {
      throw buildOutputMissingError(distDir, 'static');
    }
  } else {
    if (!fs.existsSync(serverEntry)) {
      throw buildOutputMissingError(serverDir, output);
    }
    if (!directoryHasFiles(clientDir)) {
      throw buildOutputMissingError(clientDir, output);
    }
  }

  const manifest: DeployManifest =
    output === 'static'
      ? buildStaticManifest(distDir)
      : buildSsrManifest({
          distDir,
          clientDir,
          serverDir,
          output,
        });

  // Astro's `/_image` endpoint runs INSIDE the SSR Lambda (no separate image
  // Lambda — see buildSsrManifest note). Astro's default image service is
  // `sharp`, which does `await import('sharp')` at runtime and needs the
  // native linux-x64 binary. The Vite SSR build (`noExternal`) can't bundle a
  // native `.node` module, so unless we ship sharp the app is forced onto the
  // `noop` passthrough service — which emits `content-type: image/null` and
  // never resizes (issue #3). Install a linux-x64 sharp into the server
  // bundle's node_modules AFTER the build so the runtime import resolves.
  // Skipped for static output (no SSR Lambda) and when the app explicitly
  // opted out of the sharp service (noop/passthrough/custom).
  if (output !== 'static' && !skipBuild && astroUsesSharpService(config)) {
    installSharpForAstroSsr(serverDir);
    // Astro core fetches a remote image source with `redirect: "manual"` and
    // throws on any 3xx, so an allowlisted host that 302-redirects to its CDN
    // (e.g. picsum.photos → fastly) makes `/_image` 500. Patch the built
    // server bundle to FOLLOW redirects — but re-validate every hop's host
    // against the same `image.domains`/`remotePatterns` allowlist, so a
    // redirect can't bounce past the allowlist (SSRF-safe).
    patchAstroRemoteImageRedirects(serverDir);
  }

  // Lift the user's astro.config `redirects:` table out of the SSR
  // Lambda and onto the CloudFront viewer-request Function.
  //
  // No count cap: under KVS edge routing redirects are DATA (chunked `d{n}`
  // KVS entries the viewer-request function reads at runtime), not literals
  // inlined into the function source — so the old 10 KB-CloudFront-Function
  // code limit that motivated the cap no longer applies. The authoritative
  // bound is the KVS store/chunk budget enforced centrally in
  // `buildKvsEntries` (kvs_router.ts), which throws a friendly
  // `TooManyRoutesError` / `RouteTableTooLargeError` if the tables genuinely
  // exceed the safe per-request read budget.
  if (liftedRedirects.length > 0) {
    manifest.redirects = liftedRedirects;
  }

  // Trailing-slash canonical redirects. Append AFTER user-declared lifts
  // so explicit redirects win the precedence in the CF Function.
  if (trailingSlash !== 'ignore') {
    const staticPaths = collectStaticPathsForRedirects(
      output === 'static' ? distDir : clientDir,
    );
    const tsRedirects = emitTrailingSlashRedirects(
      staticPaths,
      trailingSlash as 'always' | 'never',
    );
    if (tsRedirects.length > 0) {
      const existing = manifest.redirects ?? [];
      manifest.redirects = [...existing, ...tsRedirects];
    }
  }

  if (basePath) {
    manifest.basePath = basePath;
    process.stdout.write(
      `🔗 Detected Astro base=${basePath}; CloudFront behaviors will be prefixed.\n`,
    );
  }

  // Warn (don't fail) when a vercel.json declares crons — the hosting
  // architecture wires no scheduler, so they would silently never fire.
  // (Astro has no native cron/WebSocket server feature to detect; client-only
  // WebSocket usage works fine.)
  warnIfVercelCron(projectDir);

  // Pre-compressed sibling cleanup — CloudFront re-compresses on the
  // edge based on `Accept-Encoding`; serving the build's `.gz`/`.br`
  // copies as if they were originals breaks negotiation.
  const staticDir = manifest.staticAssets.directory;
  if (fs.existsSync(staticDir)) {
    const compressed = fg.sync('**/*.{gz,br,zst}', {
      cwd: staticDir,
      absolute: true,
      caseSensitiveMatch: false,
    });
    for (const f of compressed) fs.rmSync(f);
  }

  // Note: Injecting config files into server bundles is an integration-layer
  // concern, not an adapter concern. If a consumer needs files copied into
  // Lambda bundles, handle it in the orchestration layer that calls the adapter.
  if (output !== 'static') {
    writeRunShWrapper(serverDir);
    // Defensive: a previous tool (or an older adapter version) may have
    // left `dist/node_modules/` behind. Astro's build does not write
    // there, so anything present is unbundled and would balloon the
    // Lambda zip past the 250 MB unzipped limit.
    const strayNodeModules = path.join(distDir, 'node_modules');
    if (fs.existsSync(strayNodeModules)) {
      fs.rmSync(strayNodeModules, { recursive: true, force: true });
    }
  }

  warnIfImageOptUnreachable(manifest, staticDir);

  return manifest;
};

// ---- internal types ----

type AstroOutput = 'static' | 'server' | 'hybrid';
type AstroTrailingSlash = 'always' | 'never' | 'ignore';

type AstroConfigShape = {
  output?: AstroOutput;
  trailingSlash?: AstroTrailingSlash;
  base?: string;
  /**
   * The user's adapter integration if they wired one themselves.
   * The bridge only treats the user as having a "user-configured"
   * adapter when this field is set — checking node_modules alone is
   * unreliable because `@astrojs/node` can land in node_modules from a
   * prior install or as a transitive dep without ever being wired in
   * astro.config.
   */
  adapter?: unknown;
  image?: {
    domains?: string[];
    remotePatterns?: unknown;
    dangerouslyAllowSVG?: boolean;
    minimumCacheTTL?: number;
    /**
     * The image service. Astro's DEFAULT (unset) is the `sharp` service,
     * which needs the native `sharp` binary at runtime. We read the
     * `entrypoint` to decide whether the SSR Lambda must ship sharp — see
     * {@link astroUsesSharpService}.
     */
    service?: { entrypoint?: string; config?: unknown };
  };
};

// ---- pipeline steps ----

const assertAstroVersion = (projectDir: string): void => {
  // Read the version from `node_modules/astro/package.json` rather than
  // the project's own `package.json` spec range. This matters when:
  //   - the user declared `^4.0.0` but never ran `npm install` (no
  //     astro on disk → fail closed),
  //   - the spec is a non-semver string like `workspace:*`, `latest`,
  //     `file:../fork` (semver.coerce returned `null` before, blocking
  //     legitimate users),
  //   - the installed version drifted from the spec range and the
  //     user is on an older Astro than the declaration claims.
  const info = getPackageInfoSync('astro', { paths: [projectDir] });
  const version = info?.version;
  if (!version || !semver.gte(version, '4.0.0')) {
    throw new HostingError('UnsupportedAstroVersionError', {
      message: `Astro 4.0+ is required; ${
        version ? `installed version is ${version}` : 'astro is not installed'
      }.`,
      resolution:
        'Run `npm install astro@latest` (or your package manager equivalent). ' +
        'If you are on Astro 3.x, follow the upgrade guide at https://docs.astro.build/en/upgrade-astro/.',
    });
  }
};

const userHasAstroJsNode = (projectDir: string): boolean =>
  isPackageExists('@astrojs/node', { paths: [projectDir] });

const installAstroBridge = (
  projectDir: string,
  bodySizeLimit: number,
): (() => void) => {
  const userConfigPath = findAstroConfigPath(projectDir);
  if (!userConfigPath) {
    throw new HostingError('AstroConfigNotFoundError', {
      message: `No astro.config.{mjs,ts,mts,cjs,js} found in ${projectDir}.`,
      resolution:
        'Add an astro.config.mjs (with at least `output: "server"`) at the project root, ' +
        'or install @astrojs/node yourself and configure it in your astro.config.',
    });
  }

  const bridgeDir = path.join(projectDir, BRIDGE_DIR_REL);
  const parentDir = path.dirname(bridgeDir);
  const createdParentDir = !fs.existsSync(parentDir);
  const createdBridgeDir = !fs.existsSync(bridgeDir);

  fs.mkdirSync(bridgeDir, { recursive: true });

  // Forward-slash relative path from `<projectDir>/.hosting/astro/`
  // back to the user's config; works on both POSIX and Windows because
  // ESM resolves URLs, not native paths.
  const userConfigRelative = path.posix.join(
    '..',
    '..',
    path.basename(userConfigPath),
  );
  fs.writeFileSync(
    path.join(bridgeDir, BRIDGE_CONFIG_FILE),
    buildBridgeConfigSource(userConfigRelative, bodySizeLimit),
    'utf-8',
  );

  installAstroJsNode(projectDir);
  process.stderr.write(
    '✨ Installed Astro bridge (transparent build)\n',
  );

  return (): void => {
    try {
      const cfg = path.join(bridgeDir, BRIDGE_CONFIG_FILE);
      if (fs.existsSync(cfg)) fs.rmSync(cfg);
      if (createdBridgeDir && fs.existsSync(bridgeDir)) {
        if (fs.readdirSync(bridgeDir).length === 0) fs.rmdirSync(bridgeDir);
      }
      if (createdParentDir && fs.existsSync(parentDir)) {
        if (fs.readdirSync(parentDir).length === 0) fs.rmdirSync(parentDir);
      }
      
    } catch {
      // Best-effort cleanup; a leftover bridge directory shouldn't fail the deploy.
    }
  };
};

/**
 * Detect the package manager in use by checking for a lockfile.
 * pnpm and yarn (especially yarn-berry) write lockfiles in shapes
 * incompatible with `npm install`; running npm against a pnpm/yarn
 * project corrupts the lockfile and confuses the next `pnpm install` /
 * `yarn install` run, breaking the user's regular dev loop.
 *
 * Order matters: we check pnpm before yarn before npm because pnpm
 * projects sometimes carry a stale `package-lock.json` from a prior
 * tool. Bun ships its own lockfile shape (`bun.lock` or binary
 * `bun.lockb`); we treat that as bun.
 *
 * Return shape: { command, args } so the caller can spawn directly.
 * We pin the package version via `ASTROJS_NODE_PIN` (e.g.
 * `@astrojs/node@^9`); each manager's CLI accepts that same form.
 */
type PackageManagerInstall = {
  command: 'pnpm' | 'yarn' | 'bun' | 'npm';
  args: string[];
};

const detectPackageManagerInstallCommand = (
  projectDir: string,
  packageSpec: string,
): PackageManagerInstall => {
  const has = (file: string): boolean =>
    fs.existsSync(path.join(projectDir, file));
  if (has('pnpm-lock.yaml')) {
    return {
      command: 'pnpm',
      args: ['add', '--silent', packageSpec],
    };
  }
  if (has('yarn.lock')) {
    return {
      command: 'yarn',
      args: ['add', '--silent', packageSpec],
    };
  }
  if (has('bun.lockb') || has('bun.lock')) {
    return {
      command: 'bun',
      args: ['add', packageSpec],
    };
  }
  // npm default. `--save` is the npm default since v5; we keep it
  // explicit for clarity vs. the prior `--no-save` form.
  return {
    command: 'npm',
    args: [
      'install',
      '--save',
      '--no-audit',
      '--no-fund',
      '--silent',
      packageSpec,
    ],
  };
};

const installAstroJsNode = (projectDir: string): void => {
  // Re-check presence right before install: when a user runs the same
  // adapter twice in a single Node process (rare but observed in test
  // harnesses), the first call already installed the dep — skip the
  // second to keep the operation idempotent.
  if (userHasAstroJsNode(projectDir)) {
    return;
  }
  // Save into the user's package.json (instead of the prior `--no-save`)
  // so the dependency is pinned. Without that pin, an incremental
  // redeploy that runs `pnpm install` / `yarn install` / `npm ci` on a
  // fresh checkout (CI/CD, container builds) reinstates node_modules
  // without @astrojs/node, and the next `astro build` fails with
  // `[NoAdapterInstalled]`.
  //
  // Detect the user's package manager from their lockfile so we don't
  // corrupt it (pnpm/yarn lockfiles can't be touched by `npm install`).
  // The user will see a NEW entry in their package.json + their
  // lockfile after this install — they should commit both for
  // reproducibility.
  const install = detectPackageManagerInstallCommand(
    projectDir,
    ASTROJS_NODE_PIN,
  );
  process.stderr.write(
    `\u{1F4E6} Installing ${ASTROJS_NODE_PIN} via ${install.command} ` +
      `(saved to package.json — commit the change so CI rebuilds reproduce)\n`,
  );
  try {
    spawn.sync(install.command, install.args, {
      cwd: projectDir,
      stdio: 'inherit',
    });
  } catch (error) {
    throw new HostingError(
      'AstroBridgeInstallError',
      {
        message:
          'Failed to install @astrojs/node — required for the Astro SSR bridge.',
        resolution:
          `Try \`${install.command} ${install.args.join(' ')}\` in your project to diagnose, ` +
          'or pin @astrojs/node yourself in package.json and re-run.',
      },
      error as Error,
    );
  }
};

const buildBridgeConfigSource = (
  userConfigRelativePath: string,
  bodySizeLimit: number,
): string => `import userConfig from '${userConfigRelativePath}';
import node from '@astrojs/node';

if (userConfig.adapter) {
  process.stderr.write(
    \`[hosting:astro] replacing user adapter "\${userConfig.adapter.name}" with @astrojs/node (standalone).\\n\`,
  );
}

export default {
  ...userConfig,
  output: 'server',
  adapter: node({ mode: 'standalone', bodySizeLimit: ${bodySizeLimit} }),
  vite: {
    ...(userConfig.vite ?? {}),
    ssr: {
      ...((userConfig.vite ?? {}).ssr ?? {}),
      // Bundle every transitive dep into the server output so the
      // Lambda zip needs no node_modules at runtime. Known caveat:
      // some CJS-only packages (e.g. \`cssesc\` reached through
      // \`astro:content\` build-time sync) fail Vite's SSR module
      // runner with "module is not defined". Workarounds: avoid
      // content collections, or pin the affected package via
      // \`vite.ssr.noExternal: ['my-pkg']\` in your astro.config.
      noExternal: true,
    },
  },
};
`;

const runAstroBuild = (
  projectDir: string,
  buildCommand: string[] | undefined,
  useBridgeConfig: boolean,
): void => {
  const baseCmd =
    buildCommand && buildCommand.length > 0
      ? buildCommand
      : projectHasBuildScript(projectDir)
        ? ['npm', 'run', 'build']
        : ['npx', 'astro', 'build'];
  const cmd = useBridgeConfig
    ? [
        ...baseCmd,
        '--',
        '--config',
        path.posix.join(BRIDGE_DIR_REL, BRIDGE_CONFIG_FILE),
      ]
    : baseCmd;

  process.stderr.write(`\u{1F528} Running Astro build: ${cmd.join(' ')}\n`);
  try {
    const [bin, ...args] = cmd;
    spawn.sync(bin!, args, {
      cwd: projectDir,
      stdio: 'inherit',
    });
  } catch (error) {
    throw new HostingError(
      'AstroBuildError',
      {
        message: 'Astro build failed.',
        resolution:
          'Check the build output above. Common causes:\n' +
          '  - Missing dependencies (run: npm install)\n' +
          '  - Invalid astro.config.{ts,mjs}\n' +
          '  - TypeScript errors in your pages or components',
      },
      error as Error,
    );
  }
};

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

const ASTRO_CONFIG_FILES = [
  'astro.config.ts',
  'astro.config.mts',
  'astro.config.mjs',
  'astro.config.js',
  'astro.config.cjs',
];

const findAstroConfigPath = (projectDir: string): string | undefined =>
  ASTRO_CONFIG_FILES.map((f) => path.join(projectDir, f)).find((p) =>
    fs.existsSync(p),
  );

const loadAstroConfig = (projectDir: string): AstroConfigShape => {
  const configPath = findAstroConfigPath(projectDir);
  if (!configPath) return {};
  try {
    const jiti = createJiti(projectDir, { interopDefault: true });
    const mod = jiti(configPath) as
      | AstroConfigShape
      | { default?: AstroConfigShape };
    const config: AstroConfigShape =
      mod && typeof mod === 'object' && 'default' in mod && mod.default
        ? (mod.default as AstroConfigShape)
        : (mod as AstroConfigShape);
    return config ?? {};
  } catch (error) {
    process.stderr.write(
      `⚠️  Failed to load astro.config (${path.basename(configPath)}); ` +
        `falling back to defaults. Error: ${(error as Error).message}\n`,
    );
    return {};
  }
};

/**
 * Translate Astro's `redirects:` config table into the manifest's
 * `redirects[]` shape. Astro accepts two value forms:
 *   - string shorthand:    `'/old': '/new'`             → 301
 *   - object with status:  `'/old': { destination, status }`
 * `status` defaults to 301 when omitted. Unknown / malformed entries are
 * skipped silently — Astro treats malformed redirect entries the same way
 * (they fall through to its router) and we don't want a typo in
 * `astro.config` to fail the whole build.
 */
const liftAstroRedirects = (config: Record<string, unknown>): Redirect[] => {
  const redirects = config.redirects;
  if (!redirects || typeof redirects !== 'object') return [];
  const out: Redirect[] = [];
  for (const [source, value] of Object.entries(
    redirects as Record<string, unknown>,
  )) {
    if (typeof value === 'string') {
      out.push({ source, destination: value, statusCode: 301 });
      continue;
    }
    if (
      value &&
      typeof value === 'object' &&
      'destination' in value &&
      typeof (value as { destination?: unknown }).destination === 'string'
    ) {
      const v = value as { destination: string; status?: unknown };
      const rawStatus = typeof v.status === 'number' ? v.status : 301;
      const statusCode: 301 | 302 | 307 | 308 =
        rawStatus === 302 || rawStatus === 307 || rawStatus === 308
          ? rawStatus
          : 301;
      out.push({ source, destination: v.destination, statusCode });
    }
  }
  return out;
};

const directoryHasFiles = (dir: string): boolean => {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).length > 0;
};

const buildOutputMissingError = (
  missingPath: string,
  mode: AstroOutput,
): HostingError =>
  new HostingError('AstroBuildOutputMissingError', {
    message: `Astro ${mode} build output is missing or empty at ${missingPath}.`,
    resolution:
      mode === 'static'
        ? 'Run `astro build` and confirm `dist/` is populated.'
        : 'Run `astro build` with `output: "server"` (or `"hybrid"`) and the @astrojs/node adapter ' +
          'in standalone mode so `dist/server/entry.mjs` is emitted.',
  });

// ---- manifest builders ----

const buildStaticManifest = (distDir: string): DeployManifest => {
  const errorPages = detectErrorPages(distDir);
  return {
    version: 1,
    compute: {},
    staticAssets: {
      directory: distDir,
      // Astro content-hashes assets into `_astro/`; the rest of dist/ is
      // user HTML and assets from `public/` which must NOT be immutable.
      immutablePaths: ['_astro/*'],
      // Astro static output is ALWAYS multi-page: each route is prerendered
      // to its own `<path>/index.html`. Declare it explicitly so the L3
      // uses directory-index resolution (e.g. /about → about/index.html)
      // rather than SPA fallback (every path → /index.html). Without this,
      // a static Astro site with no 404.astro was misclassified as a SPA
      // and every route rendered the home page.
      spaFallback: false,
    },
    routes: [{ pattern: '/*', target: 'static' }],
    ...(Object.keys(errorPages).length > 0 ? { errorPages } : {}),
  };
};

/**
 * Decide whether the SSR Lambda must ship the native `sharp` binary.
 *
 * Astro's DEFAULT image service is `sharp` (config `image.service` unset).
 * The app opts OUT by pointing `image.service.entrypoint` at a non-sharp
 * service — `astro/assets/services/noop` (passthrough) or a custom service.
 * We ship sharp UNLESS the app explicitly chose such a service, so a default
 * Astro SSR app gets working `/_image` optimization automatically, while an
 * app that deliberately picked noop/custom is respected (and not bloated with
 * ~19 MB of libvips it won't call).
 * @internal
 */
export const astroUsesSharpService = (config: AstroConfigShape): boolean => {
  const entry = config.image?.service?.entrypoint;
  // Unset → Astro default → sharp. Explicit sharp entrypoint → sharp.
  if (entry === undefined || entry === null) return true;
  if (typeof entry !== 'string') return true;
  return /(^|\/)sharp$/.test(entry) || entry === 'astro/assets/services/sharp';
};

/**
 * Install a **linux-x64 glibc** `sharp` into the Astro SSR server bundle's
 * `node_modules/` so the runtime `await import('sharp')` in Astro's sharp
 * image service resolves against the Lambda's platform (Node 20, linux-x64).
 *
 * Why post-build + into the server dir: the Astro Vite build (`noExternal`)
 * can't bundle a native `.node` module, so sharp stays an external runtime
 * import. `entry.mjs` lives in `dist/server/`, so Node resolves `import('sharp')`
 * from `dist/server/node_modules/sharp` — that's the install target. The whole
 * `dist/` tree (server/ + client/) is what the L3 zips for the Lambda, so a
 * binary installed here ships with the function.
 *
 * Forces `--os=linux --cpu=x64 --libc=glibc --include=optional` (a plain
 * `npm install` on a macOS build host fetches darwin-arm64 and crashes the
 * Lambda with MissingSharp — the exact trap that pushed this app onto `noop`),
 * then prunes the `@img/sharp-wasm32` fallback (~8.7 MB, never used on
 * linux-x64) and other dead weight. Net add ≈ 19.5 MB unzipped — ~8% of
 * Lambda's 250 MB unzipped limit. Mirrors the Nitro adapter's IPX bundle.
 * @internal
 */
export const installSharpForAstroSsr = (serverDir: string): void => {
  // Idempotent: skip if a linux-x64 sharp is already present.
  const existing = path.join(
    serverDir,
    'node_modules',
    '@img',
    'sharp-linux-x64',
  );
  if (fs.existsSync(existing)) return;

  fs.mkdirSync(serverDir, { recursive: true });
  // A minimal package.json so `npm install <pkg>` writes into THIS dir's
  // node_modules and doesn't walk up to the project root.
  const pkgJsonPath = path.join(serverDir, 'package.json');
  const hadPkgJson = fs.existsSync(pkgJsonPath);
  if (!hadPkgJson) {
    fs.writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        { name: 'astro-ssr-server-bundle', private: true, type: 'module' },
        null,
        2,
      ),
      'utf-8',
    );
  }

  process.stderr.write(
    '\u{1F4F8} Installing sharp (linux-x64) into the Astro SSR bundle for /_image optimization\n',
  );
  try {
    spawn.sync(
      'npm',
      [
        'install',
        `sharp@${ASTRO_SHARP_VERSION}`,
        '--no-audit',
        '--no-fund',
        '--silent',
        '--include=optional',
        '--omit=dev',
        '--os=linux',
        '--cpu=x64',
        '--libc=glibc',
      ],
      { cwd: serverDir, stdio: 'inherit' },
    );
  } catch (error) {
    throw new HostingError(
      'AstroSharpInstallError',
      {
        message:
          'Failed to install a linux-x64 `sharp` into the Astro SSR bundle for `/_image` optimization.',
        resolution:
          'Ensure `npm` is on PATH and the build host can reach the npm registry. ' +
          'To ship without native image optimization, set `image.service` to ' +
          '`astro/assets/services/noop` in astro.config (the SSR endpoint then ' +
          'passes images through without resizing).',
      },
      error as Error,
    );
  }

  // Drop the wasm fallback (never used on linux-x64) — it's ~8.7 MB of dead
  // weight in the Lambda zip.
  const wasm = path.join(serverDir, 'node_modules', '@img', 'sharp-wasm32');
  try {
    fs.rmSync(wasm, { recursive: true, force: true });
  } catch {
    // best-effort
  }
};

/**
 * Marker injected into a patched Astro assets chunk (idempotency + tests).
 * @internal
 */
export const ASTRO_REDIRECT_PATCH_MARKER = '__blocksFetchAllowedRedirects';

/**
 * Injected helper source. Follows up to `MAX` redirects, re-validating EACH
 * hop's URL against Astro's own `isRemoteAllowed(url, allowlistConfig)` before
 * requesting it — so a redirect can never escape the `image.domains` /
 * `remotePatterns` allowlist (SSRF-safe). On a disallowed hop it returns the
 * 3xx response unchanged, letting Astro's existing 3xx-throw reject it. Uses
 * `redirect: "manual"` per hop so we see each Location.
 * @internal
 */
const ASTRO_REDIRECT_HELPER = `async function ${ASTRO_REDIRECT_PATCH_MARKER}(startUrl, allowlistConfig, isAllowed) {
  let current = startUrl;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(current, { redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get("location");
    if (!loc) return res;
    const next = new URL(loc, current).toString();
    // Re-check the redirect TARGET against the allowlist — never follow past it.
    if (allowlistConfig && isAllowed && !isAllowed(next, allowlistConfig)) return res;
    current = next;
  }
  return await fetch(current, { redirect: "manual" });
}
`;

/**
 * Patch Astro's built server bundle so the remote-image endpoint FOLLOWS
 * redirects (re-validated per hop — see {@link ASTRO_REDIRECT_HELPER}) instead
 * of throwing on the first 3xx.
 *
 * Astro core does `const response = await fetch(url, { redirect: "manual" })`
 * then throws on `status >= 300 && < 400`. An allowlisted host that 302s to
 * its CDN (picsum.photos → fastly) therefore 500s `/_image`. We replace ONLY
 * the `fetch(url, { redirect: "manual" })` call sites with the injected helper,
 * which resolves allowed redirects to a 2xx (so the existing 3xx-throw no
 * longer fires) while a disallowed redirect still returns a 3xx that Astro
 * rejects. Best-effort + idempotent: silent no-op if the shape isn't found (a
 * future Astro refactor) or the patch already ran.
 * @internal
 */
export const patchAstroRemoteImageRedirects = (serverDir: string): void => {
  if (!fs.existsSync(serverDir)) return;
  const chunks = fg.sync('**/*.mjs', {
    cwd: serverDir,
    absolute: true,
    ignore: ['**/node_modules/**'],
  });
  // Match `fetch(<urlVar>, { redirect: "manual" })` where <urlVar> is a bare
  // identifier (Astro passes the source URL variable). Whitespace-tolerant.
  const callRe =
    /await\s+fetch\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{\s*redirect:\s*["']manual["']\s*\}\s*\)/g;

  let filesPatched = 0;
  for (const chunk of chunks) {
    let src: string;
    try {
      src = fs.readFileSync(chunk, 'utf-8');
    } catch {
      continue;
    }
    // Only touch the chunk that actually fetches remote images (has the
    // allowlist symbol + the manual-redirect fetch).
    if (!/isRemoteAllowed/.test(src)) continue;
    if (src.includes(ASTRO_REDIRECT_PATCH_MARKER)) continue; // idempotent
    if (!callRe.test(src)) continue;
    callRe.lastIndex = 0;
    // Replace each `fetch(u,{redirect:"manual"})` with the helper, threading
    // the local `allowlistConfig` + imported `isRemoteAllowed`.
    let next = src.replace(
      callRe,
      `await ${ASTRO_REDIRECT_PATCH_MARKER}($1, typeof allowlistConfig !== "undefined" ? allowlistConfig : void 0, isRemoteAllowed)`,
    );
    // Inject the helper once, after the import lines at the top of the chunk.
    next = `${ASTRO_REDIRECT_HELPER}\n${next}`;
    fs.writeFileSync(chunk, next, 'utf-8');
    filesPatched++;
  }

  if (filesPatched === 0) {
    process.stderr.write(
      '⚠️  Astro remote-image redirect patch found no matching fetch(…{redirect:"manual"}); ' +
        'a redirecting allowlisted remote source may 500 on /_image ' +
        '(see patchAstroRemoteImageRedirects).\n',
    );
    return;
  }
  process.stderr.write(
    `\u{1F527} Patched Astro remote-image fetch to follow allowlisted redirects ` +
      `(${filesPatched} chunk${filesPatched > 1 ? 's' : ''}).\n`,
  );
};

const buildSsrManifest = (input: {
  distDir: string;
  clientDir: string;
  serverDir: string;
  output: AstroOutput;
}): DeployManifest => {
  // P1.6: bare and subtree forms are emitted unconditionally for
  // prerendered routes; the `emitTrailingSlashRedirects` post-pass
  // produces the canonical 308 if the user wants one. The
  // `trailingSlash` mode is read at the top-level adapter and used
  // there, not here.
  const { distDir, clientDir, serverDir, output } = input;

  // bundle: dist/  — so the Lambda zip has `server/` and `client/` as
  // siblings; @astrojs/node's standalone runtime walks `import.meta.url`
  // up to find the `server/` segment, then resolves `client/` relative
  // to it. Pointing bundle at dist/server/ would lose the `client/`
  // prefix and the static-fallback inside the standalone server would
  // 404 every prerendered route.
  const manifest: DeployManifest = {
    version: 1,
    compute: {
      default: {
        type: 'http-server',
        bundle: distDir,
        entrypoint: path.posix.join(path.basename(serverDir), RUN_SH_FILENAME),
        port: ASTRO_SERVER_PORT,
        placement: 'regional',
        runtime: 'nodejs20.x',
      },
    },
    staticAssets: {
      directory: clientDir,
      immutablePaths: ['_astro/*'],
    },
    routes: [],
  };

  // Astro middleware is bundled into entry.mjs by the standalone
  // runtime — it runs inside the regional SSR Lambda on every request.
  // We deliberately do NOT set manifest.middleware: that field tells the
  // L3 to provision a separate Lambda@Edge viewer-request association,
  // which would (a) double-invoke (one Lambda@Edge + one regional
  // Lambda) and (b) collide with the CloudFront Function the L3 already
  // attaches to viewer-request for asset-prefix / build-id rewrites.
  // The middleware bundle is still inspected later for diagnostics.

  // NOTE: Astro's image endpoint (`/_image`) is served by the standalone
  // server inside the SSR Lambda (it lives in `entry.mjs` alongside every
  // other route), so we deliberately do NOT set `manifest.imageOptimization`.
  //
  // We used to: it pointed a `type:'handler'` image Lambda at Astro's
  // `entry.handler` (an HTTP-server listener, not a native handler) and
  // emitted no route targeting `/_image`. The result was a fully dead
  // Lambda (1024 MB, reserved-concurrency 10) that received zero traffic —
  // CloudFront sent `/_image` to the catch-all SSR Lambda anyway — and that
  // would have crashed on the wrong invocation contract if it ever had been
  // wired. Letting `/_image` ride the SSR Lambda is correct: Astro applies
  // its own `image.domains` / `image.remotePatterns` there at runtime.

  const errorPages = detectErrorPages(clientDir);
  if (Object.keys(errorPages).length > 0) {
    manifest.errorPages = errorPages;
  }

  const routes: RouteBehavior[] = [{ pattern: '/_astro/*', target: 'static' }];

  // Route prerendered HTML pages to the static (S3) origin so the SSR
  // Lambda doesn't burn invocations rendering frozen content.
  //
  // This runs for BOTH `hybrid` AND `server` output. Astro 5 deprecated
  // `output: 'hybrid'` — the modern way to mix static + dynamic is
  // `output: 'server'` with per-page `export const prerender = true`.
  // Such a build still emits the prerendered pages' HTML into
  // `dist/client/` (same as hybrid did), so gating this on `=== 'hybrid'`
  // missed every prerendered page in a `server` build, sending them all
  // through the catch-all Lambda. Walking `clientDir` for `*.html` works
  // for both modes: if there are no prerendered pages, the walk is empty
  // and we just emit the catch-all. (`static` mode never reaches here —
  // it uses `buildStaticManifest`.)
  //
  // Emit a `<urlPath>/*` static (S3) route per prerendered page, matching
  // the Nitro adapter. We do NOT cap the count here: the CloudFront
  // 24-additional-behavior budget is enforced centrally by the L3
  // (`CdnConstruct`) so both adapters share one consistent limit check,
  // rather than each adapter applying its own divergent cap. The L3 also
  // derives the bare `<urlPath>` behavior from each `<urlPath>/*` route, so
  // both the bare and trailing-slash forms hit S3 (the bare path is needed
  // because CloudFront `/about/*` does NOT match `/about`).
  if (output !== 'static') {
    const prerendered = fg.sync('**/*.html', {
      cwd: clientDir,
      ignore: ['index.html', '404.html', '500.html'],
    });
    const seen = new Set<string>();
    for (const html of prerendered) {
      const urlPath = htmlToUrlPath(html);
      if (urlPath === '/' || seen.has(urlPath)) continue;
      seen.add(urlPath);
      routes.push({ pattern: `${urlPath}/*`, target: 'static' });
    }
  }

  routes.push({ pattern: '/*', target: 'default' });
  manifest.routes = dedupeRoutes(routes);

  return manifest;
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

const htmlToUrlPath = (relPath: string): string => {
  const normalized = relPath.replace(/\\/g, '/').replace(/\.html$/, '');
  let urlPath = '/' + normalized;
  urlPath = urlPath.replace(/\/index$/, '');
  return urlPath === '' ? '/' : urlPath;
};

/**
 * Walk the static asset dir and return the URL paths for prerendered
 * pages — used to seed `emitTrailingSlashRedirects`. Returns bare paths
 * with leading slash, no trailing slash. Empty when the directory
 * doesn't exist (SSR-only project with no prerender).
 */
const collectStaticPathsForRedirects = (clientOrDist: string): string[] => {
  if (!fs.existsSync(clientOrDist)) return [];
  const html = fg.sync('**/*.html', {
    cwd: clientOrDist,
    ignore: ['index.html', '404.html', '500.html'],
  });
  return html.map((rel) => htmlToUrlPath(rel)).filter((p) => p !== '/');
};

const dedupeRoutes = (routes: RouteBehavior[]): RouteBehavior[] => {
  const seen = new Set<string>();
  const out: RouteBehavior[] = [];
  for (const r of routes) {
    if (seen.has(r.pattern)) continue;
    seen.add(r.pattern);
    out.push(r);
  }
  return out;
};

const writeRunShWrapper = (serverDir: string): void => {
  const dest = path.join(serverDir, RUN_SH_FILENAME);
  fs.writeFileSync(dest, RUN_SH_SOURCE, { encoding: 'utf-8', mode: 0o755 });
};

const warnIfImageOptUnreachable = (
  manifest: DeployManifest,
  staticDir: string,
): void => {
  if (!manifest.imageOptimization) return;
  const domains = manifest.imageOptimization.domains ?? [];
  if (domains.length > 0) return;
  const localImages = fs.existsSync(staticDir)
    ? fg.sync('**/*.{png,jpg,jpeg,gif,webp,avif,svg}', {
        cwd: staticDir,
        caseSensitiveMatch: false,
      })
    : [];
  if (localImages.length === 0) {
    process.stderr.write(
      '⚠️  Image optimization is enabled but no allowed remote domains are configured\n' +
        '   and no local images were found in the static assets. If you intend to\n' +
        '   optimize remote images, set image.domains[] in astro.config.\n',
    );
  }
};
