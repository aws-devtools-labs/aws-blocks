import * as fs from 'fs';
import * as path from 'path';
import { HostingError } from '../hosting_error.js';
import { DeployManifest } from '../manifest/types.js';
import { HOSTING_DIR, STATIC_DIR } from '../constants.js';

/**
 * Filenames the SPA adapter strips from the static deploy: source maps,
 * TypeScript incremental build info, and OS metadata. Matched as a
 * lower-cased basename suffix or exact match.
 */
const STATIC_EXCLUDE_SUFFIXES = ['.map', '.tsbuildinfo'];
const STATIC_EXCLUDE_NAMES = ['.ds_store', 'thumbs.db'];

/**
 * Options for the SPA adapter.
 */
export type SpaAdapterOptions = {
  /** Explicit build output directory relative to project root. Overrides auto-detection. */
  buildOutputDir?: string;
  /**
   * Routing model declared by the caller from the framework's build
   * contract — NOT inferred from the filesystem.
   *
   *   - `true`  → single-page app (`framework: 'spa'`): extensionless
   *     paths fall back to `/index.html` for client-side routing.
   *   - `false` → multi-page static site (`framework: 'static'`): each
   *     route resolves to its own `<path>/index.html` (directory-index).
   *
   * Sourced by {@link getAdapter} from the framework string. When
   * omitted, defaults to `true` (the historical SPA behavior) so callers
   * that don't declare a model keep working. The L3 still applies its own
   * fallback heuristic when the manifest omits `spaFallback` entirely;
   * here we always set it because the framework is known.
   */
  spaFallback?: boolean;
};

/**
 * SPA adapter — transforms a built SPA output directory into the canonical
 * hosting output directory structure with a deploy manifest.
 *
 * Detects the build output directory automatically (dist/, build/, out/)
 * unless an explicit `buildOutputDir` is provided via options.
 * @param projectDir - absolute path to the project root
 * @param options - optional adapter configuration
 * @returns the generated DeployManifest
 */
export const spaAdapter = (
  projectDir: string,
  options?: SpaAdapterOptions,
): DeployManifest => {
  const buildOutputDir = options?.buildOutputDir
    ? path.join(projectDir, options.buildOutputDir)
    : detectBuildOutputDir(projectDir);

  if (!fs.existsSync(buildOutputDir)) {
    throw new HostingError('BuildOutputNotFoundError', {
      message: `Build output directory not found at ${buildOutputDir}`,
      resolution:
        'Run your build command first. Expected output in dist/, build/, or out/ directory.',
    });
  }

  const files = fs.readdirSync(buildOutputDir);
  if (files.length === 0) {
    throw new HostingError('BuildOutputEmptyError', {
      message: `Build output directory is empty: ${buildOutputDir}`,
      resolution:
        'Your build command may have failed silently. Run it locally and verify files are created in the output directory.',
    });
  }

  if (!files.includes('index.html')) {
    throw new HostingError('MissingIndexHtmlError', {
      message: 'No index.html found in the build output directory.',
      resolution: `Ensure your build command produces an index.html file in the output directory (${buildOutputDir}).`,
    });
  }

  const hostingDir = path.join(projectDir, HOSTING_DIR);
  const staticDir = path.join(hostingDir, STATIC_DIR);

  // Clean previous hosting output
  if (fs.existsSync(hostingDir)) {
    fs.rmSync(hostingDir, { recursive: true, force: true });
  }

  // Copy all build output to the hosting static directory, stripping source
  // maps, OS metadata, and TS incremental-build artefacts that should
  // not be served publicly.
  fs.cpSync(buildOutputDir, staticDir, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      if (source === buildOutputDir) return true;
      try {
        if (fs.lstatSync(source).isSymbolicLink()) return false;
      } catch {
        return false;
      }
      const name = path.basename(source).toLowerCase();
      if (STATIC_EXCLUDE_NAMES.includes(name)) return false;
      return !STATIC_EXCLUDE_SUFFIXES.some((s) => name.endsWith(s));
    },
  });

  // Generate deploy manifest. If the build emitted a real 404.html (e.g.
  // Next.js `output: 'export'`, Astro/Hugo and similar SSGs), wire it as
  // the CloudFront error page so unknown routes return a real 404 with
  // the right body. Without this, the L3 falls back to SPA mode (every
  // error → /index.html with status 200), which is wrong for static-site
  // generators that emit their own 404.
  const errorPages: {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    404?: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    500?: string;
  } = {};
  if (fs.existsSync(path.join(buildOutputDir, '404.html'))) {
    errorPages[404] = '/404.html';
  }
  if (fs.existsSync(path.join(buildOutputDir, '500.html'))) {
    errorPages[500] = '/500.html';
  }

  // Routing model comes from the caller's framework contract (see
  // SpaAdapterOptions.spaFallback), NOT from sniffing the output tree.
  // Filesystem sniffing misclassifies both ways: a real SPA that ships a
  // nested index.html (e.g. public/legal/index.html) would lose
  // client-side deep-linking, and a flat-file SSG (about.html, no
  // about/index.html) would wrongly get SPA fallback and hit the routing
  // bug this whole change fixes. `framework: 'spa'` → true (single-page);
  // `framework: 'static'` → false (multi-page). Defaults to true when the
  // caller doesn't declare one (historical SPA behavior).
  const spaFallback = options?.spaFallback ?? true;

  const manifest: DeployManifest = {
    version: 1,
    compute: {},
    staticAssets: {
      directory: staticDir,
      spaFallback,
    },
    routes: [
      {
        pattern: '/*',
        target: 'static',
      },
    ],
    ...(Object.keys(errorPages).length > 0 ? { errorPages } : {}),
  };

  return manifest;
};

/**
 * Detect the SPA build output directory.
 * Checks common build output directories in order.
 */
const detectBuildOutputDir = (projectDir: string): string => {
  const candidates = ['dist', 'build', 'out', 'public'];
  for (const candidate of candidates) {
    const dir = path.join(projectDir, candidate);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const files = fs.readdirSync(dir);
      if (files.includes('index.html')) {
        return dir;
      }
    }
  }
  // Default to dist/
  return path.join(projectDir, 'dist');
};
