// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve declared Postgres-extension names (e.g. `'postgis'`, `'pgvector'`) to
 * the PGlite `extensions` object PGlite's constructor expects.
 *
 * This exists so that `DatabaseOptions.extensions` — a declarative, local-only
 * option (see types.ts, mirroring `postgresVersion`) — never forces PGlite's
 * implementation details into application code. The mapping is intentionally a
 * small, maintained allow-list: each supported extension is distributed as its
 * own optional peer package and is `import()`-ed lazily, so a project that does
 * not declare an extension never resolves (or needs to install) its package.
 *
 * On AWS the `extensions` declaration is a no-op: Aurora PostgreSQL supports
 * PostGIS and pgvector natively, so only the local PGlite engine reads it.
 */

import type { Extension, Extensions } from '@electric-sql/pglite';

/** How a supported extension name maps to its package and PGlite namespace. */
interface ExtensionSpec {
  /** The optional peer package that ships the PGlite build of the extension. */
  pkg: string;
  /**
   * The exact version bb-data peer-pins for `pkg` (must match `peerDependencies`
   * in package.json). Each extension release peer-pins an exact
   * `@electric-sql/pglite`, so the install command must carry this version or it
   * can float onto a release whose pglite peer conflicts with bb-data's pin.
   */
  version: string;
  /** The named export to pull from that package. */
  exportName: string;
  /** The namespace key PGlite exposes the extension under. */
  namespace: string;
}

/**
 * Supported extensions. Keyed by the name a user writes in
 * `DatabaseOptions.extensions`. Accepts common aliases (`postgis`, `pgvector` /
 * `vector`) and normalizes them to one spec.
 */
const SUPPORTED_EXTENSIONS: Record<string, ExtensionSpec> = {
  postgis: { pkg: '@electric-sql/pglite-postgis', version: '0.2.11', exportName: 'postgis', namespace: 'postgis' },
  pgvector: { pkg: '@electric-sql/pglite-pgvector', version: '0.0.12', exportName: 'vector', namespace: 'vector' },
  // Alias: PGlite exposes pgvector under the `vector` namespace, so accept it too.
  vector: { pkg: '@electric-sql/pglite-pgvector', version: '0.0.12', exportName: 'vector', namespace: 'vector' },
};

/**
 * The pinned `npm install` command for a supported extension name, or `null`
 * for an unknown name. Exported for tests that keep it in lockstep with the
 * `peerDependencies` pins.
 */
export function installCommandFor(name: string): string | null {
  const spec = SUPPORTED_EXTENSIONS[name.trim().toLowerCase()];
  return spec ? `npm install ${spec.pkg}@${spec.version}` : null;
}

/** The user-facing names we accept, for error messages. */
function supportedNames(): string[] {
  return Object.keys(SUPPORTED_EXTENSIONS).sort();
}

function isModuleNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
  );
}

/**
 * Resolve declared extension names to PGlite's `{ namespace: extension }` object.
 *
 * Fails with an actionable error on the first database interaction (the dynamic
 * import runs lazily, when the engine is first used): an unknown name lists the
 * supported ones, and a missing package names the exact `npm install` command.
 * Both are developer-time configuration mistakes, so a clear, early error is
 * better DX than a confusing `CREATE EXTENSION` error several queries later.
 *
 * @param names - extension names from `DatabaseOptions.extensions`.
 * @returns the object to pass as PGlite's `extensions` option (empty when `names`
 *   is empty/undefined).
 */
export async function resolveExtensions(
  names: readonly string[] | undefined,
): Promise<Extensions> {
  if (!names || names.length === 0) return {};

  const resolved: Extensions = {};
  for (const rawName of names) {
    const name = rawName.trim().toLowerCase();
    const spec = SUPPORTED_EXTENSIONS[name];
    if (!spec) {
      throw new Error(
        `Unknown Database extension '${rawName}'. Supported extensions: ${supportedNames().join(', ')}.`,
      );
    }

    let mod: Record<string, unknown>;
    try {
      mod = (await import(spec.pkg)) as Record<string, unknown>;
    } catch (error) {
      if (isModuleNotFound(error)) {
        throw new Error(
          `Database extension '${name}' requires the '${spec.pkg}' package, which is not installed. ` +
            `Install it with:\n\n  npm install ${spec.pkg}@${spec.version}\n`,
        );
      }
      throw error;
    }

    const ext = mod[spec.exportName];
    if (ext === undefined) {
      throw new Error(
        `Package '${spec.pkg}' does not export '${spec.exportName}' for extension '${name}'. ` +
          `The installed version may be incompatible with this version of @aws-blocks/bb-data.`,
      );
    }

    resolved[spec.namespace] = ext as Extension;
  }
  return resolved;
}
