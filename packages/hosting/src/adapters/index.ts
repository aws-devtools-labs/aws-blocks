import * as fs from 'fs';
import * as path from 'path';
import { HostingError } from '../hosting_error.js';
import { spaAdapter } from './spa.js';
import { nextjsAdapter } from './nextjs.js';
import { nitroAdapter } from './nitro.js';
import { nuxtAdapter } from './nuxt.js';
import { astroAdapter } from './astro.js';
import { sveltekitAdapter } from './sveltekit.js';
import { DeployManifest } from '../manifest/types.js';

export { spaAdapter } from './spa.js';
export {
  type ComputeArch,
  type ComputeTarget,
  targetCompute,
  targetComputeArch,
  withComputeTarget,
} from './shared/compute_target.js';
export { type BuildProfile, buildProfile, withBuildProfile } from './shared/build_profile.js';
export { LAMBDA_WEB_ADAPTER_SUPPORTED_REGIONS, lambdaWebAdapterAvailableIn } from './shared/web_adapter_regions.js';
export type { SpaAdapterOptions } from './spa.js';
export { nextjsAdapter } from './nextjs.js';
export type { NextjsAdapterOptions } from './nextjs.js';
export { nitroAdapter } from './nitro.js';
export type { NitroAdapterOptions } from './nitro.js';
export { nuxtAdapter } from './nuxt.js';
export type { NuxtAdapterOptions } from './nuxt.js';
export { astroAdapter } from './astro.js';
export type { AstroAdapterOptions } from './astro.js';
export { sveltekitAdapter } from './sveltekit.js';
export type { SveltekitAdapterOptions } from './sveltekit.js';
// Re-exported so the integration layer (core `Hosting`) can normalize a
// user-declared `basePath` prop the same way adapters normalize the
// framework-config value, keeping one canonical form for `manifest.basePath`.
export { normalizeBasePath } from './shared/basepath.js';

/**
 * A framework adapter function that produces a DeployManifest from a project.
 *
 * For the new manifest format, adapters receive the project directory
 * and return a DeployManifest directly (no intermediate output directory step).
 */
export type FrameworkAdapterFn = (projectDir: string) => DeployManifest;

/**
 * Adapter registry entry.
 */
type AdapterRegistryEntry = {
  adapter: FrameworkAdapterFn;
};

/**
 * Built-in adapter registry.
 * Each adapter takes a projectDir and returns a DeployManifest.
 */
const adapterRegistry = new Map<string, AdapterRegistryEntry>([
  [
    'nextjs',
    { adapter: (projectDir: string) => nextjsAdapter({ projectDir }) },
  ],
  ['nitro', { adapter: (projectDir: string) => nitroAdapter({ projectDir }) }],
  // Nuxt is the most common Nitro consumer; keep the alias so existing
  // configs that pin `framework: 'nuxt'` keep working.
  ['nuxt', { adapter: (projectDir: string) => nuxtAdapter({ projectDir }) }],
  ['astro', { adapter: (projectDir: string) => astroAdapter({ projectDir }) }],
  [
    'sveltekit',
    { adapter: (projectDir: string) => sveltekitAdapter({ projectDir }) },
  ],
  ['spa', { adapter: spaAdapter }],
  ['static', { adapter: spaAdapter }],
]);

export { detectFramework, readProjectDeps } from './shared/detect_framework.js';

/**
 * Strict variant of {@link readProjectDeps}: throws
 * {@link HostingError} `PackageJsonParseError` on syntactically invalid
 * JSON. Returns `{}` only when `package.json` is absent.
 */
export const readProjectDepsStrict = (
  projectDir: string,
): Record<string, string> => {
  const pkgPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return {};
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch (error) {
    throw new HostingError(
      'PackageJsonParseError',
      {
        message: `Failed to parse package.json at ${pkgPath}`,
        resolution:
          'Fix JSON syntax errors in package.json, or set framework explicitly: defineHosting({ framework: "spa" })',
      },
      error as Error,
    );
  }
  return {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };
};

/**
 * Get the adapter function for the given framework type.
 * @param framework - the framework type
 * @param buildOutputDir - explicit build output directory (for SPA/static)
 * @returns the adapter function
 */
export const getAdapter = (
  framework: string,
  buildOutputDir?: string,
): FrameworkAdapterFn => {
  const entry = adapterRegistry.get(framework);
  if (!entry) {
    throw new HostingError('UnsupportedFrameworkError', {
      message: `Framework "${framework}" is not supported.`,
      resolution:
        'Use a built-in framework (nextjs, spa, static) or provide a customAdapter in your defineHosting configuration.',
    });
  }

  // Sources the routing model from the framework's build contract rather
  // than sniffing the output tree, which misclassified both a SPA shipping a
  // nested index.html and a flat-file SSG. `spa` → single-page (client-side
  // routing, /index.html fallback); `static` → multi-page (directory-index
  // resolution).
  if (framework === 'spa' || framework === 'static') {
    const spaFallback = framework === 'spa';
    return (projectDir: string) =>
      spaAdapter(projectDir, {
        ...(buildOutputDir ? { buildOutputDir } : {}),
        spaFallback,
      });
  }

  return entry.adapter;
};
