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

/**
 * A well-formed `@aws-blocks/*` package name: lowercase, starting with a letter
 * or digit, then the punctuation npm allows. On the add-to-existing paths these
 * names come from the user's own package.json and end up as arguments to npm, so
 * a key that is not a package name is never treated as one.
 */
const BLOCKS_PACKAGE = /^@aws-blocks\/[a-z0-9][a-z0-9._-]*$/;

/** The `@aws-blocks/*` packages a manifest declares as runtime dependencies. */
export function blocksDepNames(pkg: Manifest): string[] {
  return Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith('@aws-blocks/'));
}

/**
 * Removes the `@aws-blocks/*` placeholders from a manifest and returns their
 * names, to be passed to `npm install`. A range the project already declares is
 * its own choice: it is left in place and not reinstalled over. So is a key that
 * is not a well-formed package name — the CLI could not install it anyway.
 */
export function takePlaceholderBlocksDeps(pkg: Manifest): string[] {
  const deps = pkg.dependencies;
  if (!deps) return [];
  const taken = blocksDepNames(pkg).filter(
    (name) => deps[name] === PLACEHOLDER && BLOCKS_PACKAGE.test(name),
  );
  for (const name of taken) delete deps[name];
  return taken;
}
