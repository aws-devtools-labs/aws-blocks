import * as fs from 'fs';
import * as path from 'path';
import { HostingError } from '../hosting_error.js';
import { spaAdapter } from './spa.js';
import { nextjsAdapter } from './nextjs.js';
import { nitroAdapter } from './nitro.js';
import { nuxtAdapter } from './nuxt.js';
import { astroAdapter } from './astro.js';
import { DeployManifest } from '../manifest/types.js';

export { spaAdapter } from './spa.js';
export type { SpaAdapterOptions } from './spa.js';
export { nextjsAdapter } from './nextjs.js';
export type { NextjsAdapterOptions } from './nextjs.js';
export { nitroAdapter } from './nitro.js';
export type { NitroAdapterOptions } from './nitro.js';
export { nuxtAdapter } from './nuxt.js';
export type { NuxtAdapterOptions } from './nuxt.js';
export { astroAdapter } from './astro.js';
export type { AstroAdapterOptions } from './astro.js';

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
  ['spa', { adapter: spaAdapter }],
  ['static', { adapter: spaAdapter }],
]);

/**
 * Read the merged dependency map from the project's `package.json`.
 *
 * Merges `dependencies` + `devDependencies` + `peerDependencies` (later
 * sources win, matching install resolution order). Returns `{}` for any
 * read or parse failure — callers that need a hard error on syntax
 * problems should use {@link readProjectDepsStrict} instead.
 * @param projectDir - absolute path to the project root
 */
export const readProjectDeps = (projectDir: string): Record<string, string> => {
  const pkgPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return {};
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };
  } catch {
    return {};
  }
};

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
 * Frameworks built on Nitro (covers Nuxt, SolidStart, Analog,
 * TanStack Start, and standalone Nitro projects with one adapter).
 */
const NITRO_PACKAGES = [
  'nuxt',
  'nitropack',
  '@solidjs/start',
  '@analogjs/platform-server',
  '@tanstack/start',
];

/**
 * Detect the framework by reading the project's own `package.json`
 * `dependencies`, `devDependencies`, and `peerDependencies`.
 *
 * This intentionally does NOT use node_modules resolution (e.g.
 * `isPackageExists` from `local-pkg`) because that approach picks up
 * transitive and peer dependencies installed by other packages — leading
 * to false positives (e.g. a Vite SPA being detected as Next.js because
 * another package declares `next` as a peer dep).
 * @param projectDir - absolute path to the project root
 * @returns the detected framework type
 */
export const detectFramework = (projectDir: string): string => {
  const deps = readProjectDeps(projectDir);

  if ('next' in deps) {
    return 'nextjs';
  }

  // Nitro probe runs BEFORE Astro: Astro projects can pull Nitro
  // through integrations, but Nitro-only projects must win the Nitro
  // adapter. The first match in NITRO_PACKAGES wins.
  for (const pkg of NITRO_PACKAGES) {
    if (pkg in deps) {
      return 'nitro';
    }
  }

  if ('astro' in deps) {
    return 'astro';
  }

  return 'spa';
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
