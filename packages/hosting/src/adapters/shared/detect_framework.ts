/**
 * Framework detection from the project's `package.json`.
 *
 * Kept apart from `adapters/index.ts`, which loads every adapter, so
 * `nextjs_compatibility.ts` (the `@aws-blocks/hosting/nextjs-compatibility`
 * subpath) can make the same choice `Hosting` makes without loading them.
 * `adapters/index.ts` re-exports these, so its importers are unchanged.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Read the merged dependency map from the project's `package.json`.
 *
 * Merges `dependencies` + `devDependencies` + `peerDependencies` (later
 * sources win, matching install resolution order). Returns `{}` for any
 * read or parse failure — callers that need a hard error on syntax
 * problems should use `readProjectDepsStrict` (in `adapters/index.ts`) instead.
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

  // SvelteKit probe runs after the framework-specific checks above (a
  // SvelteKit app declares `@sveltejs/kit`, never `next`/`nuxt`/`astro`) and
  // before the SPA fallback. `svelte` alone (without `@sveltejs/kit`) is a
  // plain Svelte + Vite SPA, so we key on `@sveltejs/kit` specifically.
  if ('@sveltejs/kit' in deps) {
    return 'sveltekit';
  }

  return 'spa';
};
