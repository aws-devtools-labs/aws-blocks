/**
 * Resolving the `@aws-blocks/*` versions a scaffolded project depends on.
 *
 * Templates declare their blocks dependencies as `"*"`, a placeholder. Inside
 * this monorepo the CLI rewrites them to `file:` paths to the sibling packages.
 * From the published CLI it asks the registry what the current release is and
 * records a caret range, so a clean reinstall stays on the release line the app
 * was created with instead of resolving `"*"` to whatever is newest.
 */

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** Resolves a package name to the version the registry currently serves. */
export type VersionResolver = (name: string) => Promise<string>;

/** The placeholder a template ships for a dependency the CLI has to fill in. */
export const PLACEHOLDER = '*';

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;

/** The `@aws-blocks/*` packages a manifest declares as runtime dependencies. */
export function blocksDepNames(pkg: Manifest): string[] {
  return Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith('@aws-blocks/'));
}

/**
 * Asks the registry for each package's current release and returns it as a
 * caret range. Throws, naming the package, if a version cannot be established —
 * a scaffold that cannot resolve a range must fail rather than fall back to the
 * `"*"` placeholder, which would reintroduce the surprise upgrade on reinstall.
 */
export async function resolveBlocksRanges(
  names: string[],
  resolve: VersionResolver,
): Promise<Record<string, string>> {
  const resolved = await Promise.all(
    names.map(async (name) => {
      let version: string;
      try {
        version = (await resolve(name)).trim();
      } catch (error) {
        throw new Error(
          `Could not resolve a version for ${name}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (!VERSION.test(version)) {
        throw new Error(`Could not resolve a version for ${name}: the registry returned "${version}"`);
      }
      return [name, `^${version}`] as const;
    }),
  );
  return Object.fromEntries(resolved);
}

/**
 * Writes the resolved ranges into the manifest, replacing the placeholder only.
 * A range the project already declares is its own choice and is left alone.
 */
export function applyBlocksRanges(pkg: Manifest, ranges: Record<string, string>): void {
  if (!pkg.dependencies) return;
  for (const [name, range] of Object.entries(ranges)) {
    if (pkg.dependencies[name] === PLACEHOLDER) pkg.dependencies[name] = range;
  }
}
