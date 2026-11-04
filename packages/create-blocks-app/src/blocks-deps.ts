/**
 * The `@aws-blocks/*` versions a scaffolded project depends on.
 *
 * Templates declare their blocks dependencies as `"*"`, a placeholder. Inside
 * this monorepo the CLI rewrites them to `file:` paths to the sibling packages.
 * Outside it, the CLI removes the placeholders and installs the packages by
 * name, so `npm install` resolves the current release and records the range —
 * honouring the user's `save-prefix` / `save-exact` config, writing the
 * lockfile, and leaving the manifest untouched if the registry cannot answer.
 */

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** The placeholder a template ships for a dependency the CLI installs by name. */
export const PLACEHOLDER = '*';

/** The `@aws-blocks/*` packages a manifest declares as runtime dependencies. */
export function blocksDepNames(pkg: Manifest): string[] {
  return Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith('@aws-blocks/'));
}

/**
 * Removes the `@aws-blocks/*` placeholders from a manifest and returns their
 * names, to be passed to `npm install`. A range the project already declares is
 * its own choice: it is left in place and not reinstalled over.
 */
export function takePlaceholderBlocksDeps(pkg: Manifest): string[] {
  const deps = pkg.dependencies;
  if (!deps) return [];
  const taken = blocksDepNames(pkg).filter((name) => deps[name] === PLACEHOLDER);
  for (const name of taken) delete deps[name];
  return taken;
}
