#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, readFile, writeFile, rename, access, readdir, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { minimatch } from 'minimatch';
import { trackCommand } from './telemetry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The `stackId` written to `.cdk-blocks/config.json`: `name` reduced to letters, digits and hyphens, cut to
 * 16 characters, plus a 6-character random suffix. A name that starts with a character other than a
 * letter, or with "aws" in any letter case, gets the prefix `app-`.
 */
export function generateStackId(name: string): string {
  const sanitized = name
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/^[^A-Za-z]+/, 'app-')
    // AWS Resource Groups refuses a group name that starts with "aws" in any letter case, and the
    // stack's two groups are named after the stack, so such an id would fail the deploy.
    .replace(/^aws/i, 'app-$&')
    .replace(/-+/g, '-')
    .replace(/-$/, '')
    .slice(0, 16)
    .replace(/-$/, '') || 'blocks-app';
  return `${sanitized}-${randomBytes(4).toString('hex').slice(0, 6)}`;
}

/** The umbrella publishes unscoped, so a scope test alone would not recognise it. */
export const UMBRELLA_PKG = 'aws-cdk-blocks';
const SCOPE = '@aws-cdk-blocks/';

/** Whether `name` is one of this monorepo's published packages. */
export const isBlocksPackage = (name: string): boolean => name.startsWith(SCOPE) || name === UMBRELLA_PKG;

/**
 * The `packages/<dir>` directory holding `name`. The unscoped umbrella lives in `blocks`.
 * Only meaningful for a name {@link isBlocksPackage} accepts: anything else is returned
 * unchanged or truncated, so test first.
 */
export const blocksPackageDir = (name: string): string =>
  name === UMBRELLA_PKG ? 'blocks' : name.slice(SCOPE.length);

// npm `file:` installs a single package without resolving its nested
// `@aws-cdk-blocks/*` deps from the monorepo — it expects them to be
// hoisted, which only happens inside the workspace. For out-of-monorepo
// scaffolds we have to spell every sibling out as its own `file:` dep.
async function collectNestedBlocksDeps(parentDir: string, seedPkgNames: string[]): Promise<Set<string>> {
  const monorepoPkgs = new Set<string>();
  for (const entry of await readdir(parentDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const pkg = JSON.parse(await readFile(join(parentDir, entry.name, 'package.json'), 'utf-8'));
      if (typeof pkg.name === 'string' && isBlocksPackage(pkg.name)) {
        monorepoPkgs.add(pkg.name);
      }
    } catch {
      // Not a package — skip.
    }
  }

  const collected = new Set<string>();
  const queue: string[] = [...seedPkgNames];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (collected.has(name) || !monorepoPkgs.has(name)) continue;
    collected.add(name);
    const pkgName = blocksPackageDir(name);
    try {
      const sub = JSON.parse(await readFile(join(parentDir, pkgName, 'package.json'), 'utf-8'));
      for (const dep of Object.keys(sub.dependencies ?? {})) {
        if (isBlocksPackage(dep)) queue.push(dep);
      }
    } catch {
      // Missing / unparseable — skip.
    }
  }
  return collected;
}

// --- @aws-cdk-blocks/* version stamping ----------------------------------------
//
// Templates (and the add-to-existing paths below) write `*` for every
// `@aws-cdk-blocks/*` package as a placeholder. Inside the monorepo the placeholder
// becomes a `file:` path to the sibling package. From the published CLI it
// becomes the caret range listed in create-blocks-app's own devDependencies,
// which `changeset version` moves to each new release line. A scaffolded app
// therefore starts on the line this CLI release was tested against, takes later
// releases on that line on reinstall, and never moves to a new (pre-1.0:
// breaking) line until its owner edits the range. The CLI and
// `aws-cdk-blocks` form a changesets `fixed` group (.changeset/config.json),
// so every blocks release, including one forced by a new line of a package
// blocks depends on, also publishes the CLI with the moved ranges.

/**
 * Reads the range to stamp for each `@aws-cdk-blocks/*` package from
 * create-blocks-app's own manifest. The packages the CLI writes into a
 * scaffolded app are listed there as devDependencies (never installed by
 * customers), so `changeset version` keeps each range on the package's
 * current release line.
 *
 * @param cliPkg - create-blocks-app's parsed package.json.
 * @returns Package name to range, e.g. `{ 'aws-cdk-blocks': '^0.9.0' }`.
 * @throws When no `@aws-cdk-blocks/*` devDependency is listed, or one is `*` or
 *   empty. Either is a packaging bug, so the CLI fails before it writes
 *   anything.
 *
 * @example
 * resolveStampedVersions({ devDependencies: { 'aws-cdk-blocks': '^0.9.0' } });
 * // -> { 'aws-cdk-blocks': '^0.9.0' }
 */
export function resolveStampedVersions(cliPkg: { devDependencies?: Record<string, string> }): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const [name, range] of Object.entries(cliPkg.devDependencies ?? {})) {
    if (!isBlocksPackage(name)) continue;
    if (typeof range !== 'string' || range === '' || range === '*') {
      throw new Error(
        `Internal error: create-blocks-app lists ${name} with the range "${range}", which pins nothing. ` +
        'This is a bug, please report it at https://github.com/aws-devtools-labs/aws-blocks/issues',
      );
    }
    versions[name] = range;
  }
  if (Object.keys(versions).length === 0) {
    throw new Error(
      `Internal error: create-blocks-app lists no ${UMBRELLA_PKG} or @aws-cdk-blocks/* devDependencies, so it cannot pin the versions it scaffolds. ` +
      'This is a bug, please report it at https://github.com/aws-devtools-labs/aws-blocks/issues',
    );
  }
  return versions;
}

/**
 * Replaces each `*` placeholder for an `@aws-cdk-blocks/*` package in `deps` with
 * its range from `versions`, in place. Concrete ranges, `file:` paths and
 * non-`@aws-cdk-blocks` entries are left as they are.
 *
 * @param deps - A dependency map to stamp (may be undefined).
 * @param versions - The ranges from {@link resolveStampedVersions}.
 * @throws When a placeholder names a package `versions` has no range for (a
 *   template wrote a package create-blocks-app does not list).
 */
export function stampBlocksVersions(deps: Record<string, string> | undefined, versions: Record<string, string>): void {
  if (!deps) return;
  for (const [name, range] of Object.entries(deps)) {
    if (!isBlocksPackage(name) || range !== '*') continue;
    const stamp = versions[name];
    if (!stamp) {
      throw new Error(
        `Internal error: create-blocks-app has no version to pin ${name} to. ` +
        'This is a bug, please report it at https://github.com/aws-devtools-labs/aws-blocks/issues',
      );
    }
    deps[name] = stamp;
  }
}

/** The stamp ranges from the installed create-blocks-app's own package.json. */
async function loadStampedVersions(): Promise<Record<string, string>> {
  return resolveStampedVersions(JSON.parse(await readFile(join(__dirname, '../package.json'), 'utf-8')));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

// The CLI runs from the monorepo when a sibling `core` package sits next to it.
const MONOREPO_PACKAGES_DIR = join(__dirname, '../..');

async function isLocalMonorepo(): Promise<boolean> {
  return exists(join(MONOREPO_PACKAGES_DIR, 'core', 'package.json'));
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// Directory entries that do not block fresh scaffolding: common VCS, editor,
// and OS metadata that a scaffold neither reads nor writes, plus INSTRUCTIONS.md
// (a common seed file). Deliberately excludes anything the template itself
// writes (e.g. README.md, .gitignore) and directory entries that can hold user
// content, so a real user file blocks scaffolding rather than being overwritten.
// Matched by exact name; *.iml is matched by the pattern below.
export const SAFE_TO_SCAFFOLD_ENTRIES = new Set([
  '.claude', '.cursor', '.DS_Store', '.git', '.gitattributes',
  '.gitlab-ci.yml', '.hg', '.hgcheck', '.hgignore', '.idea',
  '.npmignore', '.travis.yml', '.vscode', '.zed', 'LICENSE',
  'Thumbs.db', 'mkdocs.yml', 'npm-debug.log', 'yarn-debug.log',
  'yarn-error.log', 'yarnrc.yml', 'INSTRUCTIONS.md',
]);
export const SAFE_TO_SCAFFOLD_PATTERN = /\.iml$/; // IntelliJ IDEA project files

/** Returns the entries in `dir` that would block a fresh scaffold (i.e. not in the allowlist). Empty array => safe to scaffold. */
async function conflictingEntries(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir);
  return entries.filter((e) => !SAFE_TO_SCAFFOLD_ENTRIES.has(e) && !SAFE_TO_SCAFFOLD_PATTERN.test(e));
}

async function isEmptyDir(dir: string): Promise<boolean> {
  return (await conflictingEntries(dir)).length === 0;
}

async function isAmplifyGen2Project(dir: string): Promise<boolean> {
  return exists(join(dir, 'amplify', 'backend.ts'));
}

/**
 * Whether the folder `member` (relative to the workspace root, with `/` separators) is one of
 * the root's npm `workspaces`, decided the way npm's `@npmcli/map-workspaces` does. Each entry
 * is a minimatch glob (`apps/*`, `{apps,packages}/*`, `packages/**`, `./web`); one with an odd
 * number of leading `!` excludes the folders it matches, unless an entry after it lists them again.
 */
function isWorkspaceMember(workspaces: string[], member: string): boolean {
  // npm finds the folders with `glob`, which matches case-insensitively on macOS and Windows.
  const nocase = process.platform === 'darwin' || process.platform === 'win32';
  let patterns: string[] = [];
  let excluded: string[] = [];
  for (const entry of workspaces) {
    const bangs = /^!*/.exec(entry)![0].length;
    const pattern = entry.slice(bangs).replace(/^\.?\/+/, '');
    if (bangs % 2 === 1) {
      excluded.push(pattern);
    } else {
      // An entry drops every exclusion before it that matches the entry itself: in ['packages/**',
      // '!packages/b/**', 'packages/b/a'], all of packages/b is a workspace again.
      excluded = excluded.filter((negated) => !minimatch(pattern, negated));
      patterns.push(pattern);
    }
  }
  patterns = patterns.filter((pattern) => !excluded.some((negated) => minimatch(pattern, negated)));
  // npm's glob skips node_modules and the excluded folders, matched with `dot` on.
  const ignoreOptions = { dot: true, nocase };
  const ignored = ['**/node_modules/**', ...excluded].some(
    (pattern) => minimatch(member, pattern, ignoreOptions) || minimatch(`${member}/`, pattern, ignoreOptions),
  );
  // npm globs each entry with a trailing `/` so that it matches folders only: `apps/*/` as well as `apps/*`.
  return !ignored && patterns.some((pattern) => minimatch(`${member}/`, pattern.replace(/\\/g, '/').replace(/([^/])$/, '$1/'), { nocase }));
}

/**
 * The npm workspace root that `appDir` is a workspace of, following npm's own lookup: the
 * nearest ancestor `package.json` whose `workspaces` include the app. `undefined` when the
 * app is not a workspace of any root, so it installs on its own.
 *
 * npm installs a workspace's dependencies at that root and does not nest workspaces, so it
 * ignores the app's own `"workspaces": ["cdk-blocks"]`: `cdk-blocks` is linked only when the
 * root lists the app's `cdk-blocks/` folder too, and only by an install at the root. When the
 * root does not list it, this refuses (exit 1) before anything is written, with the entry to add.
 */
async function enclosingWorkspaceRoot(appDir: string): Promise<string | undefined> {
  for (let root = dirname(appDir); ; root = dirname(root)) {
    const pkg = await readFile(join(root, 'package.json'), 'utf-8').then((text) => JSON.parse(text), () => undefined);
    const workspaces: unknown = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
    if (Array.isArray(workspaces)) {
      const patterns = workspaces.filter((p): p is string => typeof p === 'string');
      const member = relative(root, appDir).split(sep).join('/');
      if (isWorkspaceMember(patterns, member)) {
        if (isWorkspaceMember(patterns, `${member}/cdk-blocks`)) return root;
        console.error(`Error: ${appDir} is a workspace of the npm workspace root ${root}.`);
        console.error('npm installs its dependencies at that root and does not read the app\'s own');
        console.error('"workspaces": ["cdk-blocks"], so the app\'s cdk-blocks/ package would never be linked.');
        console.error('');
        console.error(`Add the app's cdk-blocks/ folder to "workspaces" in ${join(root, 'package.json')}:`);
        console.error(`  "workspaces": [${[...workspaces.map((p) => JSON.stringify(p)), JSON.stringify(`${member}/cdk-blocks`)].join(', ')}]`);
        console.error('then run this command again; it installs at that root. Nothing was written.');
        process.exit(1);
      }
    }
    if (dirname(root) === root) return undefined;
  }
}

/** Runs `npm install` for the app: at its workspace root when it has one, since npm links workspaces only there. */
function installDependencies(appDir: string, workspaceRoot: string | undefined): void {
  console.log(workspaceRoot ? `\nInstalling dependencies at the npm workspace root ${workspaceRoot}...` : '\nInstalling dependencies...');
  execSync('npm install', { cwd: workspaceRoot ?? appDir, stdio: 'inherit' });
}

/**
 * Copies shared resources (maintained once in `resources/`) into the scaffolded project.
 * `AGENTS.md` is written for the default template, so it is rewritten to the app's
 * dev port (`package.json#blocks.dev.port`) and, for a backend-only app, to say there
 * is no frontend.
 */
async function copySharedResources(targetDir: string): Promise<void> {
  const resourcesDir = join(__dirname, '../resources');
  const pkg = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf-8'));
  const guide = await readFile(join(resourcesDir, 'AGENTS.md'), 'utf-8');
  await writeFile(join(targetDir, 'AGENTS.md'), tailorAgentsGuide(guide, pkg.blocks?.dev));
}

/** Rewrites the shared `AGENTS.md` for an app's `blocks.dev` settings. */
function tailorAgentsGuide(guide: string, dev: { port?: unknown; frontend?: unknown } | undefined): string {
  const port = typeof dev?.port === 'number' ? dev.port : 3000;
  let out = guide.replaceAll('http://localhost:3000/', `http://localhost:${port}/`);
  if (dev?.frontend === false) {
    out = out.replace(
      '1. Make changes to backend (`cdk-blocks/index.ts`) or frontend (`src/`)',
      '1. Make changes to the backend (`cdk-blocks/index.ts`). This app has no frontend (`"blocks.dev.frontend": false`): its clients call the API',
    );
  }
  return out;
}

// ─── Shared workspace helper ─────────────────────────────────────────────────

/**
 * Secret and key-material patterns every CDK Blocks app git-ignores. The templates
 * ship them in their `gitignore`; adding CDK Blocks to an existing project appends
 * any that are missing, whatever the caller passes. Keep in step with the
 * template gitignores — `templates-security-defaults.test.ts` checks both.
 */
const SECRET_GITIGNORE_ENTRIES = ['.env', '.env.*', '*.pem', '*.key', '*.p12', 'credentials', '.aws/'];

/**
 * What {@link SECRET_GITIGNORE_ENTRIES} would catch but apps commit: the example
 * env file and a `credentials/` code directory. Git applies the last matching
 * line, so these always follow the patterns they carve out of. An existing
 * project only gets one when none of its own lines could already ignore that
 * name (see {@link mayIgnore}): placed after such a line, it would un-ignore it.
 */
const SECRET_GITIGNORE_EXCEPTIONS = ['!.env.example', '!credentials/'];

/**
 * Whether a `.gitignore` pattern could match a file or directory called `name`.
 * Compares the pattern's last path segment with `name`, treating `*`, `?` and
 * `[…]` as matching anything between its literal start and end. It errs towards
 * yes: a wrong yes only leaves out an exception, so the name stays ignored.
 */
function mayIgnore(pattern: string, name: string): boolean {
  const segment = pattern.replace(/\/+$/, '').split('/').pop() ?? '';
  const first = segment.search(/[*?[]/);
  if (first === -1) return segment === name;
  const last = Math.max(segment.lastIndexOf('*'), segment.lastIndexOf('?'), segment.lastIndexOf(']'));
  return name.startsWith(segment.slice(0, first)) && name.endsWith(segment.slice(last + 1));
}

/**
 * How the `.gitignore` lines treat a directory called `name` at the project
 * root: `'ignored'`, `'unignored'` (a negated line reverses the match, an
 * explicit choice to keep it), or `undefined` when no line matches.
 *
 * Git applies the last matching line per path, and can't re-include a file
 * whose parent directory is excluded. So the directory itself (`name`, `name/`,
 * a bare `*`) and its contents (`name/*`, `name/**`) are tracked apart:
 * `!name/*` re-includes the contents after `name/*`, but changes nothing after
 * `name`, which excludes the directory.
 *
 * Only literal forms count: those above, with an optional leading `/` or
 * double-star segment. Unlike {@link mayIgnore}, this check is biased towards
 * no match, so the caller adds the line: a wrong match leaves `name`
 * unignored, while a duplicate line is harmless. So globs and character
 * classes (`[!n]ode_modules`, `n*s`) do not count, nor does a line with
 * leading whitespace or a trailing tab, which git reads as part of the pattern,
 * nor a negation that reverses no earlier match. Pass the raw lines; a pattern
 * for a path below the root (`packages/site/node_modules`) does not count
 * either.
 */
function rootDirectoryIgnoreState(lines: string[], name: string): 'ignored' | 'unignored' | undefined {
  let directory: 'ignored' | 'unignored' | undefined;
  let contents: 'ignored' | 'unignored' | undefined;
  for (const raw of lines) {
    // Git strips trailing spaces (unless escaped), but not tabs or leading spaces.
    // A loop rather than / +$/, which backtracks quadratically on a long run of spaces.
    let end = raw.length;
    while (end > 0 && raw[end - 1] === ' ') end--;
    const line = raw.slice(0, end);
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const path = (negated ? line.slice(1) : line).replace(/^(\*\*\/|\/)/, '');
    if (path === name || path === `${name}/`) {
      directory = negated ? 'unignored' : 'ignored';
    } else if (path === `${name}/*` || path === `${name}/**`) {
      if (!negated) contents = 'ignored';
      // Re-including the contents works only while the directory itself isn't excluded.
      else if (contents === 'ignored' && directory !== 'ignored') contents = 'unignored';
    } else if (path === '*' || path === '*/') {
      // `!*` or `!*/` (an allow-list re-including directories) is no choice about `name`.
      directory = negated ? undefined : 'ignored';
      if (negated) contents = undefined;
    }
  }
  if (directory === 'ignored' || contents === 'ignored') return 'ignored';
  if (directory === 'unignored' || contents === 'unignored') return 'unignored';
  return undefined;
}

/**
 * Adds the cdk-blocks workspace to an existing project's package.json.
 * Shared between `integrateWithExistingProject()` and `integrateWithAmplify()`.
 *
 * Handles:
 * - Adding "cdk-blocks" to workspaces (array or Yarn Classic object format)
 * - Adding devDependencies and dependencies
 * - Adding scripts to package.json
 * - Adding CDK Blocks task settings (`package.json#blocks`) when the project has none
 * - Patching .gitignore: the caller's entries plus {@link SECRET_GITIGNORE_ENTRIES},
 *   and `node_modules` when no existing line ignores or un-ignores it (these steps add dependencies)
 * - Monorepo detection and file: path rewriting
 * - Stamping `*` placeholders for `@aws-cdk-blocks/*` deps with the CLI's ranges
 *   (published CLI only; a range the project already lists in `dependencies`
 *   is kept)
 * - Running npm install
 */
async function addBlocksWorkspace(targetDir: string, options: {
  devDeps: Record<string, string>;
  deps: Record<string, string>;
  scripts: Record<string, string>;
  /** `package.json#blocks`, read by CDK Blocks tasks (for example `{ dev: { port: 3001 } }`). */
  blocksConfig?: Record<string, unknown>;
  gitignoreEntries: string[];
  skipInstall?: boolean;
  /** The npm workspace root the project is a workspace of, from {@link enclosingWorkspaceRoot}; it installs there. */
  workspaceRoot?: string;
}): Promise<Record<string, string>> {
  const { scripts, blocksConfig, gitignoreEntries, skipInstall, workspaceRoot } = options;
  const deps = { ...options.deps };
  const devDeps = { ...options.devDeps };

  // From the published CLI, resolve `@aws-cdk-blocks/*` placeholders before any
  // file is touched, so a packaging bug fails without a half-written project.
  const localMonorepo = await isLocalMonorepo();
  if (!localMonorepo) {
    const versions = await loadStampedVersions();
    stampBlocksVersions(deps, versions);
    stampBlocksVersions(devDeps, versions);
  }

  // Modify package.json
  const pkgPath = join(targetDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));

  // Add workspaces — handle Yarn Classic object format.
  // Note: converting { packages: [...], nohoist: [...] } to a bare array drops sibling keys
  // like nohoist. Acceptable trade-off for our target audience (npm/Yarn Modern).
  if (!pkg.workspaces) pkg.workspaces = [];
  if (!Array.isArray(pkg.workspaces)) pkg.workspaces = pkg.workspaces?.packages || [];
  if (!pkg.workspaces.includes('cdk-blocks')) {
    pkg.workspaces.push('cdk-blocks');
  }

  // Add dependencies
  if (!pkg.dependencies) pkg.dependencies = {};
  for (const [dep, ver] of Object.entries(deps)) {
    if (!pkg.dependencies[dep]) pkg.dependencies[dep] = ver;
  }

  // Add devDependencies
  if (!pkg.devDependencies) pkg.devDependencies = {};
  for (const [dep, ver] of Object.entries(devDeps)) {
    if (!pkg.devDependencies[dep]) pkg.devDependencies[dep] = ver;
  }

  // Monorepo detection for local dev
  if (localMonorepo) {
    const parentDir = MONOREPO_PACKAGES_DIR;
    const seed = Object.keys(pkg.dependencies ?? {}).filter((d: string) =>
      isBlocksPackage(d),
    );
    const allBlocksDeps = await collectNestedBlocksDeps(parentDir, seed);
    for (const dep of allBlocksDeps) {
      const pkgName = blocksPackageDir(dep);
      pkg.dependencies[dep] = `file:${parentDir}/${pkgName}`;
    }
  }

  const installedScripts: Record<string, string> = {};
  pkg.scripts ??= {};
  const hostScripts = pkg.scripts;
  for (const [name, cmd] of Object.entries(scripts)) {
    const fallback = name.startsWith('blocks:') ? name : `blocks:${name}`;
    let actual = name;
    // Preserve host scripts and avoid triggering unrelated npm lifecycle hooks.
    for (let suffix = actual === fallback ? 2 : 1;
      (Object.hasOwn(hostScripts, actual) && hostScripts[actual] !== cmd) ||
      Object.hasOwn(hostScripts, `pre${actual}`) || Object.hasOwn(hostScripts, `post${actual}`);
      suffix++) {
      actual = suffix === 1 ? fallback : `${fallback}:${suffix}`;
    }
    hostScripts[actual] = cmd;
    installedScripts[name] = actual;
  }

  // Add CDK Blocks task settings without overriding any the project already has.
  if (blocksConfig) {
    if (!pkg.blocks || typeof pkg.blocks !== 'object') pkg.blocks = {};
    for (const [key, value] of Object.entries(blocksConfig)) {
      if (pkg.blocks[key] === undefined) pkg.blocks[key] = value;
    }
  }

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  console.log('  ✓ Modified package.json');

  // Modify .gitignore
  const gitignorePath = join(targetDir, '.gitignore');
  let gitignore = '';
  if (await exists(gitignorePath)) {
    gitignore = await readFile(gitignorePath, 'utf-8');
  }
  // Compare whole lines: a substring check takes an existing `.env.local` for `.env`.
  // Git applies the last matching line, so an entry is present only if the last
  // line naming it ignores it: `.env` followed by `!.env` leaves `.env` to add.
  const existing = gitignore.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const ignores = new Map<string, boolean>();
  for (const line of existing) {
    if (line.startsWith('!')) ignores.set(line.slice(1), false);
    else ignores.set(line, true);
  }
  const present = (entry: string) => ignores.get(entry) === true;
  const toAdd = gitignoreEntries.filter(entry => !present(entry));
  const secretsToAdd = SECRET_GITIGNORE_ENTRIES.filter(entry => !present(entry));
  const patterns = existing.filter(line => !line.startsWith('!'));
  const exceptions = SECRET_GITIGNORE_EXCEPTIONS.filter(exception => {
    const name = exception.slice(1).replace(/\/$/, '');
    return !patterns.some(pattern => mayIgnore(pattern, name));
  });
  // The dependencies added above make the next install create `node_modules`.
  // The templates ignore it in their `gitignore`; a project that has no line
  // for it (often one with no `.gitignore` at all) gets the same. A project
  // that un-ignores it (vendored dependencies) is left as it is.
  const nodeModulesState = rootDirectoryIgnoreState(gitignore.split(/\r?\n/), 'node_modules');
  if (nodeModulesState === 'unignored') {
    console.log('  ℹ Left node_modules as your .gitignore configures it (un-ignored)');
  }
  const dependencyLines = nodeModulesState === undefined ? ['node_modules'] : [];
  if (dependencyLines.length > 0 || toAdd.length > 0 || secretsToAdd.length > 0) {
    // Keep a CRLF file CRLF: appending LF-only lines would mix line endings.
    const eol = gitignore.includes('\r\n') ? '\r\n' : '\n';
    const secretLines = secretsToAdd.length > 0 ? [...secretsToAdd, ...exceptions] : [];
    if (dependencyLines.length > 0) gitignore += `${eol}# Dependencies${eol}${dependencyLines.join(eol)}${eol}`;
    if (toAdd.length > 0) gitignore += `${eol}# AWS CDK Blocks${eol}${toAdd.join(eol)}${eol}`;
    if (secretLines.length > 0) {
      gitignore += `${eol}# Secrets and key material — never commit${eol}${secretLines.join(eol)}${eol}`;
    }
    await writeFile(gitignorePath, gitignore);
    // These lines change what the project ignores (`.env.*` also covers
    // `.env.development` / `.env.production`), so list them.
    console.log(`  ✓ Modified .gitignore (+${[...dependencyLines, ...toAdd, ...secretLines].join(', ')})`);
  }

  // Install dependencies
  if (!skipInstall) installDependencies(targetDir, workspaceRoot);
  return installedScripts;
}

/** The package-script entry every CDK Blocks task runs through; a task script appends ` <task>`. */
const RUN_ENTRY = `node --input-type=module -e "import 'aws-cdk-blocks/run'" --`;

/**
 * Reuse the selected template's CDK Blocks tasks, not its frontend or lifecycle scripts.
 * That includes the `cdk-blocks` passthrough, which is the entry with no task after it.
 */
function templateTasks(scripts: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(scripts).filter(([name, command]) =>
    name !== 'prebuild' && (command === RUN_ENTRY || command.startsWith(`${RUN_ENTRY} `)),
  ));
}

function printTaskNames(scripts: Record<string, string>): void {
  const renamed = Object.entries(scripts).filter(([name, actual]) => name !== actual);
  if (renamed.length === 0) return;
  console.log('\nCDK Blocks tasks renamed to preserve your existing scripts:');
  for (const [name, actual] of renamed) console.log(`  ${name} → ${actual}`);
}

/** These files are newly copied template sources, never host-authored files. */
async function tailorTaskExamples(dir: string, scripts: Record<string, string>, files: string[]): Promise<void> {
  if (!Object.entries(scripts).some(([name, actual]) => name !== actual)) return;
  for (const file of files) {
    const path = join(dir, file);
    const original = await readFile(path, 'utf-8');
    const updated = original.replace(/(npm run (?:-s )?)([\w:-]+)/g, (match, prefix, name) =>
      Object.hasOwn(scripts, name) ? `${prefix}${scripts[name]}` : match);
    if (updated !== original) await writeFile(path, updated);
  }
}

// ─── Template discovery ─────────────────────────────────────────────────────
//
// Templates are the ONLY source of truth for the template list. Each template
// under `templates/<name>/` ships a `package.json` with:
//   {
//     "blocksTemplate": "<name>",
//     "blocksTemplateDescription": "One-line description shown in --help"
//   }
//
// Adding a new template = drop a folder with a package.json containing those
// two fields. The CLI's --help, validation, and error messages all pick it up
// automatically — no other code changes required.
//
// An optional `blocksTemplateOverlayOnly: true` marks a template as an overlay
// that's auto-selected when the CLI detects a matching existing project (e.g.
// `amplify`) rather than a scaffoldable fresh-app starter; `createFreshProject`
// rejects it up front. A folder whose package.json can't be read is still shown
// in --help (flagged) but excluded from `--template` validation.
//
// Display order below is preserved from the previous hardcoded list so that
// `--help` reads in the intended progression (default → bare → richer variants
// → framework variants → overlays → demos). New templates default to
// alphabetical after known ones. Update this array to reorder.

type TemplateInfo = {
  name: string;
  description: string;
  valid: boolean;
  overlayOnly: boolean;
};

const TEMPLATE_DISPLAY_ORDER = ['default', 'bare', 'react', 'backend', 'api-only', 'sql', 'nextjs', 'auth', 'auth-oidc', 'agent', 'cron', 'observability', 'amplify', 'demo'];

// Former template names that still resolve to a template, so existing
// `--template <old name>` invocations (docs, scripts, CI) keep working after a
// rename. `--help` lists them separately from the template list.
//   auth-cognito → auth: there is one auth Building Block (`Auth`) now, so the
//   template is named for what it shows, not for a choice between auth blocks.
export const TEMPLATE_ALIASES: Readonly<Record<string, string>> = {
  'auth-cognito': 'auth',
};

/** Resolve a former template name to its current one, with a one-line note. */
function resolveTemplateAlias(templateName: string): string {
  const target = Object.hasOwn(TEMPLATE_ALIASES, templateName) ? TEMPLATE_ALIASES[templateName] : undefined;
  if (target === undefined) return templateName;
  console.log(`Note: the "${templateName}" template is now called "${target}"; using "${target}".`);
  return target;
}

let templateCatalogCache: TemplateInfo[] | null = null;

async function loadTemplateCatalog(): Promise<TemplateInfo[]> {
  if (templateCatalogCache) return templateCatalogCache;

  const templatesDir = join(__dirname, '../templates');
  const entries = await readdir(templatesDir, { withFileTypes: true });
  const discovered: TemplateInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(templatesDir, entry.name, 'package.json');
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      discovered.push({
        name: entry.name,
        description: typeof pkg.blocksTemplateDescription === 'string'
          ? pkg.blocksTemplateDescription
          : '(no description — add `blocksTemplateDescription` to this template\'s package.json)',
        valid: true,
        overlayOnly: pkg.blocksTemplateOverlayOnly === true,
      });
    } catch {
      // Template folder without a readable package.json — surface it so it's
      // discoverable, but flag that metadata is missing.
      discovered.push({
        name: entry.name,
        description: '(no package.json — template metadata missing)',
        valid: false,
        overlayOnly: false,
      });
    }
  }

  // Sort by TEMPLATE_DISPLAY_ORDER, then any unknown templates alphabetically.
  discovered.sort((a, b) => {
    const aIdx = TEMPLATE_DISPLAY_ORDER.indexOf(a.name);
    const bIdx = TEMPLATE_DISPLAY_ORDER.indexOf(b.name);
    if (aIdx === -1 && bIdx === -1) return a.name.localeCompare(b.name);
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  });

  templateCatalogCache = discovered;
  return discovered;
}

async function validateTemplateName(templateName: string): Promise<void> {
  const catalog = await loadTemplateCatalog();
  const names = catalog.filter(t => t.valid).map(t => t.name);
  if (!names.includes(templateName)) {
    console.error(`Error: Unknown template "${templateName}".`);
    console.error(`Available templates: ${names.join(', ')}`);
    process.exit(1);
  }
}

// ─── Fresh project creation ──────────────────────────────────────────────────

async function createFreshProject(targetDir: string, templateName: string, skipInstall = false) {
  await validateTemplateName(templateName);

  // Overlay templates (e.g. `amplify`, detected via `isAmplifyGen2Project()`)
  // are auto-selected when the CLI finds a matching existing project and are
  // flagged `blocksTemplateOverlayOnly` in their package.json. They ship only an
  // overlay snippet — not a full standalone project (no `src/`, no `index.html`,
  // no `gitignore`) — so a fresh scaffold would fail partway through the copy.
  // Reject up front. Keying off the catalog flag (not a hardcoded name) means a
  // new overlay template needs no change here — just the flag in its package.json.
  const overlayEntry = (await loadTemplateCatalog()).find(t => t.name === templateName);
  if (overlayEntry?.overlayOnly) {
    console.error(`Error: The \`${templateName}\` template is an overlay that's auto-selected`);
    console.error('when the CLI detects a compatible existing project. It cannot be');
    console.error('scaffolded as a fresh app.');
    console.error('');
    console.error('To scaffold a fresh AWS CDK Blocks app, choose a different template:');
    console.error('  npx @aws-cdk-blocks/create-blocks-app my-app --template default');
    console.error('');
    console.error('To integrate CDK Blocks into an existing project, run this from');
    console.error('the project root:');
    console.error('  npx @aws-cdk-blocks/create-blocks-app');
    process.exit(1);
  }

  const workspaceRoot = await enclosingWorkspaceRoot(targetDir);

  // Read template package.json to get template name
  const templateDir = join(__dirname, '../templates', templateName);
  const templatePkgPath = join(templateDir, 'package.json');
  const templatePkg = JSON.parse(await readFile(templatePkgPath, 'utf-8'));
  
  let appName = basename(targetDir);
  if (appName === '.' || appName === '') {
    // resolve() ensures "." becomes the actual directory name (e.g., "my-app" instead of ".")
    appName = basename(resolve(targetDir));
  }
  // Sanitize appName for use as CDK construct ID / CloudFormation stack name.
  // CDK rejects names not matching /^[A-Za-z][A-Za-z0-9-]*$/ — it does NOT sanitize.
  appName = appName
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/^[^A-Za-z]+/, 'app-')
    .replace(/-+/g, '-')
    .replace(/-$/, '') || 'blocks-app';
  
  // From the published CLI, resolve the `@aws-cdk-blocks/*` ranges before anything
  // is written (see the version stamping section above). Stamping a copy of
  // the template's manifest here makes a placeholder with no range throw now,
  // not after the template has been copied.
  const localMonorepo = await isLocalMonorepo();
  const stampedVersions = localMonorepo ? null : await loadStampedVersions();
  if (stampedVersions) {
    stampBlocksVersions({ ...templatePkg.dependencies }, stampedVersions);
    stampBlocksVersions({ ...templatePkg.devDependencies }, stampedVersions);
  }

  console.log(`Creating AWS CDK Blocks app in ${targetDir}...`);

  // Copy template
  await mkdir(targetDir, { recursive: true });
  await cp(templateDir, targetDir, { recursive: true });

  // Overlay shared resources (AGENTS.md — maintained once, not per-template)
  await copySharedResources(targetDir);

  // Rename gitignore to .gitignore
  await rename(join(targetDir, 'gitignore'), join(targetDir, '.gitignore'));
  
  // Fix package.json
  const pkgPath = join(targetDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
  
  // Set package name
  pkg.name = appName;

  // Record the template version that scaffolded this project
  pkg.blocksTemplateVersion = templatePkg.version;
  
  // When running from the local monorepo, rewrite @aws-cdk-blocks/* deps
  // to file: paths so they resolve to sibling packages. When running from
  // the published registry (via npx), the sibling packages won't exist on
  // disk, so the `*` placeholders are stamped with the caret ranges this CLI
  // release ships and resolve from the registry instead.
  if (localMonorepo) {
    const parentDir = MONOREPO_PACKAGES_DIR;
    const seed = Object.keys(pkg.dependencies ?? {}).filter((d) =>
      isBlocksPackage(d),
    );
    const allBlocksDeps = await collectNestedBlocksDeps(parentDir, seed);
    for (const dep of allBlocksDeps) {
      const pkgName = blocksPackageDir(dep);
      pkg.dependencies[dep] = `file:${parentDir}/${pkgName}`;
    }
  } else if (stampedVersions) {
    stampBlocksVersions(pkg.dependencies, stampedVersions);
    stampBlocksVersions(pkg.devDependencies, stampedVersions);
  }
  
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  
  // Generate .cdk-blocks/config.json with a unique stackId
  const stackId = generateStackId(appName);
  const blocksConfigDir = join(targetDir, '.cdk-blocks');
  await mkdir(blocksConfigDir, { recursive: true });
  await writeFile(join(blocksConfigDir, 'config.json'), JSON.stringify({ stackId }, null, 2));
  
  if (!skipInstall) installDependencies(targetDir, workspaceRoot);
  
  // The template's local dev port: 3001 for the backend-only templates.
  const devPort = templatePkg.blocks?.dev?.port ?? 3000;
  console.log('\n✓ CDK Blocks app created!');
  console.log(`\nNext steps:`);
  console.log(`  cd ${quoteForShell(targetDir)}`);
  if (skipInstall) {
    console.log(workspaceRoot ? `  (cd ${quoteForShell(workspaceRoot)} && npm install)` : `  npm install`);
  }
  console.log(`  npm run dev`);
  if (templatePkg.blocks?.dev?.frontend === false) {
    console.log(`\nThe API then listens on http://localhost:${devPort}/cdk-blocks/api (backend only; README.md has a curl example).`);
  } else {
    console.log(`\nThen open http://localhost:${devPort}`);
  }
  console.log('\nRun `npm run help` to see available CDK Blocks tasks.');
  console.log(`\nSee README.md for an overview and AGENTS.md for AI agent instructions.`);
}

/** `path` as one shell word that pastes into the user's shell: quoted when it has a space or another special character. */
function quoteForShell(path: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(path)) return path;
  // cmd.exe and PowerShell take a double-quoted path; POSIX shells take a single-quoted one.
  return process.platform === 'win32' ? `"${path}"` : `'${path.replaceAll("'", `'\\''`)}'`;
}

// ─── Amplify Gen 2 integration ──────────────────────────────────────────────

async function integrateWithAmplify(targetDir: string, skipConfirm = false, skipInstall = false) {
  const workspaceRoot = await enclosingWorkspaceRoot(targetDir);
  console.log('\n🔍 Detected Amplify Gen 2 project (amplify/backend.ts found)\n');
  console.log('This will add AWS CDK Blocks to your existing Amplify project:');
  console.log('');
  console.log('  CREATE  cdk-blocks/           (CDK Blocks backend workspace)');
  console.log('  CREATE  amplify/blocks.ts     (wires CDK Blocks into Amplify backend)');
  console.log('  MODIFY  amplify/backend.ts    (adds import for blocks.ts)');
  console.log('  MODIFY  package.json          (adds workspace, deps, scripts)');
  console.log('  MODIFY  .gitignore            (adds CDK Blocks entries, node_modules if missing, and secret and key-material patterns)');
  console.log('  CREATE  amplify.yml           (or modify existing — adds CDK conditions)');
  console.log('');
  console.log('No changes will be committed. Review the diff before committing.');
  console.log('');

  const proceed = skipConfirm || await confirm('Proceed?');
  if (!proceed) {
    console.log('Aborted.');
    process.exit(0);
  }

  console.log('\n📦 Scaffolding CDK Blocks...\n');

  // 1. Copy cdk-blocks/ template. Its package.json declares its own
  // `@aws-cdk-blocks/*` placeholders, which the published CLI stamps too; they are
  // stamped in memory before the copy, so a placeholder with no range throws
  // before anything is written (see the version stamping section above).
  const templateDir = join(__dirname, '../templates/amplify');
  const awsBlocksSrc = join(templateDir, 'cdk-blocks');
  const awsBlocksDest = join(targetDir, 'cdk-blocks');
  const stampedVersions = (await isLocalMonorepo()) ? null : await loadStampedVersions();
  let workspacePkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null = null;
  if (stampedVersions) {
    workspacePkg = JSON.parse(await readFile(join(awsBlocksSrc, 'package.json'), 'utf-8'));
    // A package the project root already lists keeps the root's range here too,
    // so the workspace and the root resolve to one copy of it. Only packages the
    // CLI stamps are overridden (a missing stamp still fails here, before any
    // write), devDependencies win as they do in npm's resolution of the root,
    // and only semver ranges are copied: `*`, blanks, dist-tags and path or
    // protocol specs (`./x`, `file:`, `link:`, ...) get the CLI's stamp instead,
    // since a path would resolve from a different directory here.
    const rootPkg = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf-8'));
    const rootRanges: Record<string, unknown> = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
    const workspaceVersions = { ...stampedVersions };
    for (const [name, range] of Object.entries(rootRanges)) {
      if (name in stampedVersions && typeof range === 'string' && /^\s*(?:[\^~]\s*v?\d|[<>=]|v?\d)/.test(range)) {
        workspaceVersions[name] = range;
      }
    }
    stampBlocksVersions(workspacePkg?.dependencies, workspaceVersions);
    stampBlocksVersions(workspacePkg?.devDependencies, workspaceVersions);
  }
  await cp(awsBlocksSrc, awsBlocksDest, { recursive: true });
  if (workspacePkg) {
    await writeFile(join(awsBlocksDest, 'package.json'), `${JSON.stringify(workspacePkg, null, 2)}\n`);
  }
  const amplifyPkg = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf-8'));
  await writeBackendTsconfig(awsBlocksDest, amplifyPkg);
  console.log('  ✓ Created cdk-blocks/');

  // 2. Copy amplify/blocks.ts
  const blocksTsSrc = join(templateDir, 'amplify-blocks.ts');
  const blocksTsDest = join(targetDir, 'amplify', 'blocks.ts');
  await cp(blocksTsSrc, blocksTsDest);
  console.log('  ✓ Created amplify/blocks.ts');

  // 3. Modify amplify/backend.ts — add CDK Blocks initialization at the end
  const backendTsPath = join(targetDir, 'amplify', 'backend.ts');
  let backendTs = await readFile(backendTsPath, 'utf-8');
  if (!backendTs.includes('./blocks')) {
    const blocksSnippet = `\n// CDK Blocks integration — adds Building Blocks to your Amplify backend\nimport { initBlocks } from './blocks.js';\nawait initBlocks(backend);\n`;
    let patched = false;

    if (!backendTs.includes('export const backend') && !backendTs.includes('export { backend }')) {
      if (backendTs.includes('const backend = defineBackend(')) {
        backendTs = backendTs.replace('const backend = defineBackend(', 'export const backend = defineBackend(');
        patched = true;
      } else if (backendTs.match(/defineBackend\s*\(/)) {
        backendTs = backendTs.replace(/defineBackend\s*\(/, 'export const backend = defineBackend(');
        patched = true;
      }
    } else {
      patched = true; // already exported
    }

    if (patched) {
      backendTs += blocksSnippet;
      await writeFile(backendTsPath, backendTs);
      console.log('  ✓ Modified amplify/backend.ts');
    } else {
      const manualSnippetPath = join(targetDir, 'amplify', 'blocks-manual-patch.txt');
      await writeFile(manualSnippetPath, [
        '// Could not auto-patch amplify/backend.ts.',
        '// Please add the following to the END of amplify/backend.ts:',
        '//',
        '// 1. Ensure `backend` is exported:',
        '//    export const backend = defineBackend({ ... });',
        '//',
        '// 2. Append these lines at the bottom:',
        blocksSnippet,
      ].join('\n'));
      console.log('  ⚠️  Could not auto-patch amplify/backend.ts');
      console.log('     See amplify/blocks-manual-patch.txt for instructions.');
    }
  }

  // 4. Add CDK Blocks workspace (package.json, .gitignore, deps, install)
  const standalone = JSON.parse(await readFile(join(__dirname, '../templates/default/package.json'), 'utf-8'));
  const clientScript = 'cross-env NODE_OPTIONS="--conditions=aws-runtime" tsx cdk-blocks/scripts/generate-client.ts';
  const scripts = await addBlocksWorkspace(targetDir, {
    // `*` is a placeholder: addBlocksWorkspace stamps it with the CLI's range.
    deps: { 'aws-cdk-blocks': '*' },
    devDeps: {
      'tsx': '^4.7.0',
      'esbuild': '^0.27.1',
      '@types/node': '^22.12.0',
      'cross-env': '^7.0.3',
    },
    scripts: {
      'sandbox': 'cross-env NODE_OPTIONS="--conditions=cdk" AMPLIFY_SANDBOX=true npx ampx sandbox',
      'sandbox:delete': 'cross-env NODE_OPTIONS="--conditions=cdk" npx ampx sandbox delete --yes',
      'blocks:dev': standalone.scripts.dev,
      'blocks:stop': standalone.scripts['dev:stop'],
      // Keep Cognito middleware and the API URL from amplify_outputs.json.
      'blocks:generate-client': clientScript,
      'generate-client': clientScript,
      ...Object.fromEntries(['docs', 'docs:search', 'docs:api', 'whoami', 'help', 'cdk-blocks', 'db', 'migrate']
        .map(name => [name, standalone.scripts[name]])),
    },
    // The CDK Blocks dev server runs backend-only on :3001; the Amplify app runs its own frontend,
    // so `"frontend": false` stops the dev task from detecting the app's vite or next.
    // `"generateClient": false` keeps the overlay's own cdk-blocks/client.js (the Cognito token
    // and the amplify_outputs.json API URL): the dev server would replace it with the generic one.
    blocksConfig: { dev: { port: 3001, frontend: false, generateClient: false } },
    gitignoreEntries: ['.cdk-blocks-sandbox', '.cdk-blocks/local/', '.bb-data/'],
    skipInstall,
    workspaceRoot,
  });
  await tailorTaskExamples(awsBlocksDest, scripts, ['scripts/generate-client.ts']);

  // 5. Handle amplify.yml
  await handleAmplifyYml(targetDir);

  console.log('\n✓ CDK Blocks integrated with your Amplify Gen 2 app!\n');
  console.log('Next steps:');
  console.log(`  npm run ${scripts.sandbox}  # Deploy Amplify + CDK Blocks to sandbox`);
  console.log(`  npm run ${scripts['blocks:dev']}  # Run CDK Blocks local dev server`);
  console.log(`  npm run ${scripts['generate-client']}  # Regenerate the Amplify-aware client`);
  console.log(`  npm run ${scripts.help}  # List CDK Blocks tasks`);
  printTaskNames(scripts);
  console.log('Your CDK Blocks API is available at the /api endpoint alongside your Amplify backend.');
  console.log('');
  printTypeScriptSteps(amplifyPkg);
  printMigrationInstructions(scripts.sandbox, standalone.scripts.sandbox);
}

function printMigrationInstructions(sandboxTask: string, standaloneSandboxScript: string) {
  console.log('─── Migration to CDK Blocks-native (optional) ────────────────────────');
  console.log('');
  console.log('To make your app "CDK Blocks-native with Amplify as a guest":');
  console.log('');
  console.log('1. Move CDK orchestration from amplify/backend.ts to cdk-blocks/index.cdk.ts');
  console.log('   - Use BlocksStack.create() instead of BlocksBackend.create()');
  console.log('   - Import Amplify resources into the CDK Blocks stack');
  console.log('');
  console.log(`2. Run the sandbox through CDK Blocks: replace the Amplify command in the \`${sandboxTask}\` script with:`);
  console.log(`   ${standaloneSandboxScript}`);
  console.log(`   Then use \`npm run ${sandboxTask}\`.`);
  console.log('   - CDK Blocks sandbox uses CDK directly (no Amplify CLI dependency)');
  console.log('');
  console.log('3. Update amplify.yml to use CDK deploy directly:');
  console.log('   backend.phases.build.commands:');
  console.log('     - npx cdk deploy --require-approval never --app="npx tsx -C cdk cdk-blocks/index.cdk.ts"');
  console.log('');
  console.log('This gives you full control over the CDK stack while keeping');
  console.log('Amplify Hosting for CI/CD and frontend deployment.');
  console.log('──────────────────────────────────────────────────────────────────');
  console.log('');
}

async function handleAmplifyYml(targetDir: string) {
  const ymlPath = join(targetDir, 'amplify.yml');

  if (await exists(ymlPath)) {
    let yml = await readFile(ymlPath, 'utf-8');
    if (yml.includes('--conditions=cdk')) {
      console.log('  ✓ amplify.yml already has CDK conditions');
      return;
    }
    if (yml.includes('npx ampx pipeline-deploy')) {
      yml = yml.replace(
        /^(\s*-\s*)(npx ampx pipeline-deploy.*)/m,
        '$1export NODE_OPTIONS="--conditions=cdk"\n$1$2'
      );
      await writeFile(ymlPath, yml);
      console.log('  ✓ Modified amplify.yml (added CDK conditions)');
    } else if (yml.includes('backend:')) {
      yml = yml.replace(
        /(backend:\s*\n\s*phases:\s*\n\s*build:\s*\n\s*commands:\s*\n)/,
        '$1        - export NODE_OPTIONS="--conditions=cdk"\n'
      );
      await writeFile(ymlPath, yml);
      console.log('  ✓ Modified amplify.yml (added CDK conditions)');
    } else {
      console.log('  ⚠️  amplify.yml exists but could not detect where to add NODE_OPTIONS.');
      console.log('     Please add this to your backend build commands manually:');
      console.log('       - export NODE_OPTIONS="--conditions=cdk"');
    }
  } else {
    const yml = `version: 1
backend:
  phases:
    build:
      commands:
        - export NODE_OPTIONS="--conditions=cdk"
        - npx ampx pipeline-deploy --branch $AWS_BRANCH --app-id $AWS_APP_ID
frontend:
  phases:
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: dist
    files:
      - '**/*'
  cache:
    paths:
      - node_modules/**/*
`;
    await writeFile(ymlPath, yml);
    console.log('  ✓ Created amplify.yml');
  }
}

// ─── Init into existing project ─────────────────────────────────────────────

/**
 * The template's `blocks` settings that suit any existing project: the dev server
 * `port` and the backend-only `frontend: false`. The template's frontend settings
 * describe the template's own frontend, not the project's, so they are left out and
 * the dev task detects the project's frontend dev server from its dependencies.
 * `undefined` when nothing is left to copy.
 */
function backendDevConfig(blocks: unknown): Record<string, unknown> | undefined {
  const dev = (blocks as { dev?: Record<string, unknown> } | undefined)?.dev;
  if (!dev || typeof dev !== 'object') return undefined;
  const kept: Record<string, unknown> = {};
  if (dev.port !== undefined) kept.port = dev.port;
  if (dev.frontend !== undefined) kept.frontend = dev.frontend;
  return Object.keys(kept).length > 0 ? { dev: kept } : undefined;
}

async function integrateWithExistingProject(targetDir: string, templateName = 'default', skipConfirm = false, skipInstall = false) {
  if (templateName === 'amplify') {
    throw new Error('The amplify template requires an existing Amplify Gen 2 project (amplify/backend.ts).');
  }
  const workspaceRoot = await enclosingWorkspaceRoot(targetDir);
  console.log('\n🔍 Detected existing project (package.json found)\n');
  console.log('This will add an AWS CDK Blocks backend to your project:');
  console.log('');
  console.log('  CREATE  cdk-blocks/           (CDK Blocks backend workspace)');
  console.log('  CREATE  cdk.json              (CDK configuration)');
  console.log('  MODIFY  package.json          (adds workspace, deps, scripts)');
  console.log('  MODIFY  .gitignore            (adds CDK Blocks entries, node_modules if missing, and secret and key-material patterns)');
  console.log('');

  const proceed = skipConfirm || await confirm('Proceed?');
  if (!proceed) {
    console.log('Aborted.');
    process.exit(0);
  }

  console.log('\n📦 Adding CDK Blocks backend...\n');

  // From the published CLI, check the `@aws-cdk-blocks/*` placeholder below has a
  // range before anything is written (addBlocksWorkspace stamps it later).
  const blocksDeps = { 'aws-cdk-blocks': '*' };
  if (!(await isLocalMonorepo())) stampBlocksVersions({ ...blocksDeps }, await loadStampedVersions());

  // 1. Copy cdk-blocks/ from the requested template. The dev task detects the
  // project's own frontend dev server (`next dev` or `vite`) from its dependencies,
  // so only the template's backend settings are copied below.
  const templateDir = join(__dirname, '../templates', templateName);
  const awsBlocksSrc = join(templateDir, 'cdk-blocks');
  const awsBlocksDest = join(targetDir, 'cdk-blocks');

  if (await exists(awsBlocksDest)) {
    console.error('  ✗ cdk-blocks/ already exists. Aborting to avoid overwriting.');
    process.exit(1);
  }

  await cp(awsBlocksSrc, awsBlocksDest, { recursive: true });
  const existingPkg = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf-8'));
  await writeBackendTsconfig(awsBlocksDest, existingPkg);

  // Generate blocks/config.json with a unique stackId
  const baseName = (existingPkg.name || basename(resolve(targetDir)));
  const stackId = generateStackId(baseName);
  const blocksConfigDir = join(targetDir, '.cdk-blocks');
  await mkdir(blocksConfigDir, { recursive: true });
  await writeFile(join(blocksConfigDir, 'config.json'), JSON.stringify({ stackId }, null, 2));

  console.log('  ✓ Created cdk-blocks/');

  // 2. Copy cdk.json
  const cdkJsonDest = join(targetDir, 'cdk.json');
  if (!(await exists(cdkJsonDest))) {
    await cp(join(templateDir, 'cdk.json'), cdkJsonDest);
    console.log('  ✓ Created cdk.json');
  } else {
    console.log('  ⚠ cdk.json already exists, skipping');
  }

  // 3. Add CDK Blocks workspace (package.json, .gitignore, deps, install).
  // Source devDeps versions from the template's package.json — single source of truth.
  const templatePkg = JSON.parse(await readFile(join(templateDir, 'package.json'), 'utf-8'));
  const tplDevDeps = templatePkg.devDependencies || {};
  const tasks = templateTasks(templatePkg.scripts);
  const scripts = await addBlocksWorkspace(targetDir, {
    // `*` is a placeholder: addBlocksWorkspace stamps it with the CLI's range.
    // The copied cdk-blocks/ backend validates its API input with zod, at the template's version.
    deps: { ...blocksDeps, ...(templatePkg.dependencies?.zod && { zod: templatePkg.dependencies.zod }) },
    devDeps: {
      'aws-cdk-lib': tplDevDeps['aws-cdk-lib'] || '2.257.0',
      'aws-cdk': tplDevDeps['aws-cdk'] || '^2.1147.0',
      'constructs': tplDevDeps['constructs'] || '^10.6.0',
      'tsx': tplDevDeps['tsx'] || '^4.7.0',
      'esbuild': tplDevDeps['esbuild'] || '^0.27.1',
      '@types/node': tplDevDeps['@types/node'] || '^22.12.0',
    },
    scripts: { ...tasks, 'dev:server': tasks.dev },
    blocksConfig: backendDevConfig(templatePkg.blocks),
    gitignoreEntries: ['.cdk-blocks-sandbox', 'cdk.out/', 'cdk-blocks/client.js', 'cdk-blocks/blocks.spec.json', '.cdk-blocks/local/', '.bb-data/'],
    skipInstall,
    workspaceRoot,
  });
  await tailorTaskExamples(awsBlocksDest, scripts, ['index.ts', 'index.cdk.ts']);

  console.log('\n✓ CDK Blocks backend added to your project!\n');
  console.log('Next steps:');
  console.log(`  npm run ${scripts.sandbox}  # Deploy backend to your AWS sandbox`);
  console.log(`  npm run ${scripts['dev:server']}  # Run local dev server`);
  console.log(`  npm run ${scripts.help}  # List CDK Blocks tasks`);
  console.log(`  npm run ${scripts.docs}  # Browse Building Block documentation`);
  printTaskNames(scripts);
  console.log('');
  console.log('Import your API in frontend code:');
  console.log('  import { api } from \'cdk-blocks\'');
  console.log('');
  printTypeScriptSteps(existingPkg);
}

/** The guide section with the TypeScript steps below, also for apps scaffolded before templates split their tsconfig. */
const TYPESCRIPT_STEPS_URL =
  'https://github.com/aws-devtools-labs/aws-blocks/blob/main/docs/guides/upgrading-older-apps.md#keep-node-types-out-of-the-frontend';

/** The dependencies of a project's package.json. */
interface PackageDeps {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

/** Whether the project builds with Next.js, whose `next build` ignores project references when it type-checks. */
function usesNext(pkg: PackageDeps): boolean {
  return Boolean(pkg.dependencies?.next || pkg.devDependencies?.next);
}

/**
 * Gives the copied backend its own TypeScript project, `cdk-blocks/tsconfig.json`,
 * with Node types (see printTypeScriptSteps): the template's, or the default
 * template's when the template ships none (the backend-only templates, the Amplify
 * overlay). Not in a Next.js project, which typechecks cdk-blocks/ as part of the
 * app: nothing there would build the project, and editors and the deploy bundling
 * (esbuild) would read it for backend files instead of the app's tsconfig.json,
 * without the app's "paths".
 */
async function writeBackendTsconfig(awsBlocksDest: string, pkg: PackageDeps): Promise<void> {
  const backendTsconfig = join(awsBlocksDest, 'tsconfig.json');
  if (usesNext(pkg)) {
    await rm(backendTsconfig, { force: true });
  } else if (!(await exists(backendTsconfig))) {
    await cp(join(__dirname, '../templates/default/cdk-blocks/tsconfig.json'), backendTsconfig);
  }
}

/**
 * Prints how to make an existing project's TypeScript build read the backend through
 * the project in `cdk-blocks/tsconfig.json`, which typechecks it with Node types.
 * Printed, never applied: the project's tsconfig and scripts are its own. A Next.js
 * project gets no steps: `next build` ignores project references when it
 * type-checks, so it keeps checking `cdk-blocks/` as part of the app.
 */
function printTypeScriptSteps(pkg: PackageDeps): void {
  if (usesNext(pkg)) {
    console.log('TypeScript: leave your Next.js tsconfig.json as it is. `next build` typechecks cdk-blocks/');
    console.log('as part of your app, with the Node types your tsconfig.json has when it sets no "types".');
  } else {
    console.log('TypeScript: cdk-blocks/tsconfig.json typechecks the backend with Node types. To keep them out');
    console.log('of your frontend, add "references": [{ "path": "./cdk-blocks" }] to the tsconfig that compiles');
    console.log('the code importing \'cdk-blocks\', and typecheck with `tsc -b --force` instead of `tsc`');
    console.log('(if the script used --noEmit, set "noEmit": true in that tsconfig instead).');
  }
  console.log(`Details: ${TYPESCRIPT_STEPS_URL}`);
  console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function printUsage() {
  const catalog = await loadTemplateCatalog();
  const names = catalog.map(t => t.name);
  const widest = catalog.length ? Math.max(...catalog.map(t => t.name.length)) : 0;
  const templateList = catalog
    .map(t => `    ${t.name.padEnd(widest)}   ${t.description}`)
    .join('\n');
  const aliasList = Object.entries(TEMPLATE_ALIASES)
    .map(([from, to]) => `${from} → ${to}`)
    .join(', ');

  console.log(`Usage: create-blocks-app [directory] [options]

Create a new AWS CDK Blocks app or add it to an existing project.

The mode is auto-detected based on the target directory:

  1. Amplify project detected (amplify/backend.ts exists):
     Integrates CDK Blocks into your Amplify Gen 2 backend.

  2. Existing project detected (package.json exists, no Amplify):
     Adds the cdk-blocks/ backend workspace to your project.
     Works with any framework — Vite, Next.js, SvelteKit, Astro, etc.

  3. Empty or new directory:
     Creates a standalone CDK Blocks starter app from a template. A directory
     that contains only benign metadata (e.g. .git, editor config) or an
     INSTRUCTIONS.md is still treated as empty; any other pre-existing file
     blocks scaffolding so it is never overwritten.

Arguments:
  directory              Target directory (default: ".")

Options:
  --template <name>      Template to use. For fresh projects it selects the
                         starter app; when adding to an existing project it
                         selects which cdk-blocks/ workspace to copy, e.g.
                         "nextjs" for a Next.js dev server (default: "default")

                         Available templates: ${names.join(', ')}

${templateList}

                         Former names (still accepted): ${aliasList}

  --skip-install         Skip installing dependencies
  -y, --yes              Skip confirmation prompts
  -h, --help             Show this help message

Examples:
  npx @aws-cdk-blocks/create-blocks-app                            Add CDK Blocks to current project
  npx @aws-cdk-blocks/create-blocks-app .                          Add CDK Blocks to current project
  npx @aws-cdk-blocks/create-blocks-app my-app                     Create a standalone CDK Blocks starter app
  npx @aws-cdk-blocks/create-blocks-app . --yes --template nextjs  Non-interactive scaffold with the Next.js template
`);
}

async function create() {
  const args = process.argv.slice(2);
  let targetDir: string | null = null;
  let templateName = 'default';
  let skipConfirm = false;
  let skipInstall = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      await printUsage();
      process.exit(0);
    } else if (args[i] === '--template' || args[i].startsWith('--template=')) {
      const value = args[i] === '--template' ? args[++i] : args[i].slice('--template='.length);
      if (!value || value.startsWith('-')) {
        console.error('Error: Missing value for --template.');
        console.error(`Run with --help for usage information.`);
        process.exit(1);
      }
      templateName = value;
    } else if (args[i] === '--yes' || args[i] === '-y') {
      skipConfirm = true;
    } else if (args[i] === '--skip-install') {
      skipInstall = true;
    } else if (args[i].startsWith('--telemetry-file')) {
      // Handled by telemetry module — skip (also skip the next arg if `--telemetry-file path` form)
      if (args[i] === '--telemetry-file' && i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
    } else if (args[i].startsWith('-')) {
      console.error(`Unknown option: ${args[i]}`);
      console.error(`Run with --help for usage information.`);
      process.exit(1);
    } else if (!targetDir) {
      targetDir = args[i];
    } else {
      console.error(`Unexpected argument: ${args[i]}`);
      console.error(`Run with --help for usage information.`);
      process.exit(1);
    }
  }

  templateName = resolveTemplateAlias(templateName);
  await validateTemplateName(templateName);

  const templatePkgVersion: string = JSON.parse(
    await readFile(join(__dirname, '../templates', templateName, 'package.json'), 'utf-8'),
  ).version;

  return trackCommand('create-blocks-app', async () => {
    const resolvedDir = resolve(targetDir || '.');

    // Mode 1: Amplify Gen 2 project detected
    if (await isAmplifyGen2Project(resolvedDir)) {
      await integrateWithAmplify(resolvedDir, skipConfirm, skipInstall);
      return;
    }

    // Mode 2: Existing project (package.json, no Amplify) — triggered when the
    // resolved directory contains a package.json (covers no-arg, ".", or named dir)
    if (await exists(join(resolvedDir, 'package.json'))) {
      await integrateWithExistingProject(resolvedDir, templateName, skipConfirm, skipInstall);
      return;
    }

    // Mode 3: Create fresh project (empty/non-existent dir)
    if (await isEmptyDir(resolvedDir)) {
      if (!targetDir) {
        const tplDir = join(__dirname, '../templates', templateName);
        const tplPkg = JSON.parse(await readFile(join(tplDir, 'package.json'), 'utf-8'));
        const templateDisplayName = tplPkg.blocksTemplate || templateName;
        targetDir = join('blocks-demo-apps', `template-${templateDisplayName}`);
      }
      await createFreshProject(resolve(targetDir), templateName, skipInstall);
      return;
    }

    // None of the above: dir has entries that are not in the safe-to-scaffold allowlist.
    const conflicts = await conflictingEntries(resolvedDir);
    console.error('Error: Target directory is not empty and no package.json found.');
    console.error('');
    if (conflicts.length > 0) {
      console.error('The directory contains files that would conflict with scaffolding:');
      for (const entry of conflicts) console.error(`  ${entry}`);
      console.error('');
    }
    console.error('To add AWS CDK Blocks to an existing project, run from the project root:');
    console.error('  npx @aws-cdk-blocks/create-blocks-app');
    console.error('');
    console.error('To create a fresh CDK Blocks app, specify a new directory:');
    console.error('  npx @aws-cdk-blocks/create-blocks-app my-app');
    process.exit(1);
  }, { template: templateName, templateVersion: templatePkgVersion });
}

// Run the CLI only when this module is the entry point. Resolve argv[1]
// through its real path first so an npm bin symlink (node_modules/.bin/…)
// still matches this module's real file location. Guarding the auto-run
// lets tests import the exported allowlist constants without scaffolding.
const entryArg = process.argv[1];
if (entryArg) {
  let entryUrl: string | undefined;
  try {
    entryUrl = pathToFileURL(realpathSync(entryArg)).href;
  } catch {
    entryUrl = pathToFileURL(entryArg).href;
  }
  if (import.meta.url === entryUrl) {
    // A failed step (such as `npm install`) must fail the command, so `create-blocks-app app && cd app` stops there.
    create().catch((error: unknown) => {
      console.error(error instanceof Error ? `Error: ${error.message}` : error);
      process.exitCode = 1;
    });
  }
}
