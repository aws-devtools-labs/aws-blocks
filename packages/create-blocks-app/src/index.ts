#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, readFile, writeFile, rename, access, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { minimatch } from 'minimatch';
import { trackCommand } from './telemetry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function generateStackId(name: string): string {
  const sanitized = name
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/^[^A-Za-z]+/, 'app-')
    .replace(/-+/g, '-')
    .replace(/-$/, '')
    .slice(0, 16)
    .replace(/-$/, '') || 'blocks-app';
  return `${sanitized}-${randomBytes(4).toString('hex').slice(0, 6)}`;
}

// npm `file:` installs a single package without resolving its nested
// `@aws-blocks/*` deps from the monorepo — it expects them to be
// hoisted, which only happens inside the workspace. For out-of-monorepo
// scaffolds we have to spell every sibling out as its own `file:` dep.
async function collectNestedBlocksDeps(parentDir: string, seedPkgNames: string[]): Promise<Set<string>> {
  const monorepoPkgs = new Set<string>();
  for (const entry of await readdir(parentDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const pkg = JSON.parse(await readFile(join(parentDir, entry.name, 'package.json'), 'utf-8'));
      if (typeof pkg.name === 'string' && pkg.name.startsWith('@aws-blocks/')) {
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
    const pkgName = name.replace('@aws-blocks/', '');
    try {
      const sub = JSON.parse(await readFile(join(parentDir, pkgName, 'package.json'), 'utf-8'));
      for (const dep of Object.keys(sub.dependencies ?? {})) {
        if (dep.startsWith('@aws-blocks/')) queue.push(dep);
      }
    } catch {
      // Missing / unparseable — skip.
    }
  }
  return collected;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
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
 * ignores the app's own `"workspaces": ["aws-blocks"]`: `aws-blocks` is linked only when the
 * root lists the app's `aws-blocks/` folder too, and only by an install at the root. When the
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
        if (isWorkspaceMember(patterns, `${member}/aws-blocks`)) return root;
        console.error(`Error: ${appDir} is a workspace of the npm workspace root ${root}.`);
        console.error('npm installs its dependencies at that root and does not read the app\'s own');
        console.error('"workspaces": ["aws-blocks"], so the app\'s aws-blocks/ package would never be linked.');
        console.error('');
        console.error(`Add the app's aws-blocks/ folder to "workspaces" in ${join(root, 'package.json')}:`);
        console.error(`  "workspaces": [${[...workspaces.map((p) => JSON.stringify(p)), JSON.stringify(`${member}/aws-blocks`)].join(', ')}]`);
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
      '1. Make changes to backend (`aws-blocks/index.ts`) or frontend (`src/`)',
      '1. Make changes to the backend (`aws-blocks/index.ts`). This app has no frontend (`"blocks.dev.frontend": false`): its clients call the API',
    );
  }
  return out;
}

// ─── Shared workspace helper ─────────────────────────────────────────────────

/**
 * Adds the aws-blocks workspace to an existing project's package.json.
 * Shared between `integrateWithExistingProject()` and `integrateWithAmplify()`.
 *
 * Handles:
 * - Adding "aws-blocks" to workspaces (array or Yarn Classic object format)
 * - Adding devDependencies and dependencies
 * - Adding scripts to package.json
 * - Adding the `cdk-blocks` CLI settings (`package.json#blocks`) when the project has none
 * - Patching .gitignore
 * - Monorepo detection and file: path rewriting
 * - Running npm install
 */
async function addBlocksWorkspace(targetDir: string, options: {
  devDeps: Record<string, string>;
  deps: Record<string, string>;
  scripts: Record<string, string>;
  /** `package.json#blocks`, read by the `cdk-blocks` CLI (for example `{ dev: { port: 3001 } }`). */
  blocksConfig?: Record<string, unknown>;
  gitignoreEntries: string[];
  skipInstall?: boolean;
  /** The npm workspace root the project is a workspace of, from {@link enclosingWorkspaceRoot}; it installs there. */
  workspaceRoot?: string;
}): Promise<void> {
  const { devDeps, deps, scripts, blocksConfig, gitignoreEntries, skipInstall, workspaceRoot } = options;

  // Modify package.json
  const pkgPath = join(targetDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));

  // Add workspaces — handle Yarn Classic object format.
  // Note: converting { packages: [...], nohoist: [...] } to a bare array drops sibling keys
  // like nohoist. Acceptable trade-off for our target audience (npm/Yarn Modern).
  if (!pkg.workspaces) pkg.workspaces = [];
  if (!Array.isArray(pkg.workspaces)) pkg.workspaces = pkg.workspaces?.packages || [];
  if (!pkg.workspaces.includes('aws-blocks')) {
    pkg.workspaces.push('aws-blocks');
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
  const parentDir = join(__dirname, '../..');
  const isLocalMonorepo = await access(join(parentDir, 'core', 'package.json')).then(() => true, () => false);
  if (isLocalMonorepo) {
    const seed = Object.keys(pkg.dependencies ?? {}).filter((d: string) =>
      d.startsWith('@aws-blocks/'),
    );
    const allBlocksDeps = await collectNestedBlocksDeps(parentDir, seed);
    for (const dep of allBlocksDeps) {
      const pkgName = dep.replace('@aws-blocks/', '');
      pkg.dependencies[dep] = `file:${parentDir}/${pkgName}`;
    }
  }

  // Add scripts
  if (!pkg.scripts) pkg.scripts = {};
  for (const [name, cmd] of Object.entries(scripts)) {
    if (!pkg.scripts[name]) pkg.scripts[name] = cmd;
  }

  // Add the `cdk-blocks` CLI settings, without overriding any the project already has
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
  const toAdd = gitignoreEntries.filter(entry => !gitignore.includes(entry));
  if (toAdd.length > 0) {
    gitignore += `\n# AWS Blocks\n${toAdd.join('\n')}\n`;
    await writeFile(gitignorePath, gitignore);
    console.log('  ✓ Modified .gitignore');
  }

  // Install dependencies
  if (!skipInstall) installDependencies(targetDir, workspaceRoot);
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

const TEMPLATE_DISPLAY_ORDER = ['default', 'bare', 'react', 'backend', 'api-only', 'sql', 'nextjs', 'auth', 'amplify', 'demo'];

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
    console.error('To scaffold a fresh Blocks app, choose a different template:');
    console.error('  npx @aws-blocks/create-blocks-app my-app --template default');
    console.error('');
    console.error('To integrate Blocks into an existing project, run this from');
    console.error('the project root:');
    console.error('  npx @aws-blocks/create-blocks-app');
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
  
  console.log(`Creating Blocks app in ${targetDir}...`);
  
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
  
  // When running from the local monorepo, rewrite @aws-blocks/* deps
  // to file: paths so they resolve to sibling packages. When running from
  // the published registry (via npx), the sibling packages won't exist on
  // disk — leave deps as-is so they resolve from the registry instead.
  const parentDir = join(__dirname, '../..');
  const isLocalMonorepo = await access(join(parentDir, 'core', 'package.json')).then(() => true, () => false);

  if (isLocalMonorepo) {
    const seed = Object.keys(pkg.dependencies ?? {}).filter((d) =>
      d.startsWith('@aws-blocks/'),
    );
    const allBlocksDeps = await collectNestedBlocksDeps(parentDir, seed);
    for (const dep of allBlocksDeps) {
      const pkgName = dep.replace('@aws-blocks/', '');
      pkg.dependencies[dep] = `file:${parentDir}/${pkgName}`;
    }
  }
  
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  
  // Generate .blocks/config.json with a unique stackId
  const stackId = generateStackId(appName);
  const blocksConfigDir = join(targetDir, '.blocks');
  await mkdir(blocksConfigDir, { recursive: true });
  await writeFile(join(blocksConfigDir, 'config.json'), JSON.stringify({ stackId }, null, 2));
  
  if (!skipInstall) installDependencies(targetDir, workspaceRoot);
  
  // The local server port the template's `cdk-blocks dev` listens on: 3001 for the backend-only templates.
  const devPort = templatePkg.blocks?.dev?.port ?? 3000;
  console.log('\n✓ Blocks app created!');
  console.log(`\nNext steps:`);
  console.log(`  cd ${quoteForShell(targetDir)}`);
  if (skipInstall) {
    console.log(workspaceRoot ? `  (cd ${quoteForShell(workspaceRoot)} && npm install)` : `  npm install`);
  }
  console.log(`  npm run dev`);
  if (templatePkg.blocks?.dev?.frontend === false) {
    console.log(`\nThe API then listens on http://localhost:${devPort}/aws-blocks/api (backend only; README.md has a curl example).`);
  } else {
    console.log(`\nThen open http://localhost:${devPort}`);
  }
  console.log(`\nEvery npm script calls the cdk-blocks CLI; run \`npx --no -- cdk-blocks --help\` to see all commands.`);
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
  console.log('This will add Blocks to your existing Amplify project:');
  console.log('');
  console.log('  CREATE  aws-blocks/           (Blocks backend workspace)');
  console.log('  CREATE  amplify/blocks.ts     (wires Blocks into Amplify backend)');
  console.log('  MODIFY  amplify/backend.ts    (adds import for blocks.ts)');
  console.log('  MODIFY  package.json          (adds workspace, deps, scripts)');
  console.log('  MODIFY  .gitignore            (adds Blocks entries)');
  console.log('  CREATE  amplify.yml           (or modify existing — adds CDK conditions)');
  console.log('');
  console.log('No changes will be committed. Review the diff before committing.');
  console.log('');

  const proceed = skipConfirm || await confirm('Proceed?');
  if (!proceed) {
    console.log('Aborted.');
    process.exit(0);
  }

  console.log('\n📦 Scaffolding Blocks...\n');

  // 1. Copy aws-blocks/ template
  const templateDir = join(__dirname, '../templates/amplify');
  const awsBlocksSrc = join(templateDir, 'aws-blocks');
  const awsBlocksDest = join(targetDir, 'aws-blocks');
  await cp(awsBlocksSrc, awsBlocksDest, { recursive: true });
  console.log('  ✓ Created aws-blocks/');

  // 2. Copy amplify/blocks.ts
  const blocksTsSrc = join(templateDir, 'amplify-blocks.ts');
  const blocksTsDest = join(targetDir, 'amplify', 'blocks.ts');
  await cp(blocksTsSrc, blocksTsDest);
  console.log('  ✓ Created amplify/blocks.ts');

  // 3. Modify amplify/backend.ts — add Blocks initialization at the end
  const backendTsPath = join(targetDir, 'amplify', 'backend.ts');
  let backendTs = await readFile(backendTsPath, 'utf-8');
  if (!backendTs.includes('./blocks')) {
    const blocksSnippet = `\n// Blocks integration — adds Building Blocks to your Amplify backend\nimport { initBlocks } from './blocks.js';\nawait initBlocks(backend);\n`;
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

  // 4. Add Blocks workspace (package.json, .gitignore, deps, install)
  await addBlocksWorkspace(targetDir, {
    deps: { '@aws-blocks/blocks': '*' },
    devDeps: {
      'tsx': '^4.7.0',
      'esbuild': '^0.27.1',
      '@types/node': '^20.0.0',
      'cross-env': '^7.0.3',
    },
    scripts: {
      'sandbox': 'cross-env NODE_OPTIONS="--conditions=cdk" AMPLIFY_SANDBOX=true npx ampx sandbox',
      'sandbox:delete': 'cross-env NODE_OPTIONS="--conditions=cdk" npx ampx sandbox delete --yes',
      'blocks:dev': 'cdk-blocks dev',
      'blocks:stop': 'cdk-blocks dev stop',
      // The CLI's `cdk-blocks generate client` has no Amplify preamble (auth middleware and
      // the API URL from amplify_outputs.json), so the overlay keeps its own generator.
      'blocks:generate-client': 'cross-env NODE_OPTIONS="--conditions=aws-runtime" tsx aws-blocks/scripts/generate-client.ts',
    },
    // The Blocks dev server runs backend-only on :3001; the Amplify app runs its own frontend,
    // so `"frontend": false` stops `cdk-blocks dev` from detecting the app's vite or next.
    blocksConfig: { dev: { port: 3001, frontend: false } },
    gitignoreEntries: ['.blocks-sandbox', '.bb-data/'],
    skipInstall,
    workspaceRoot,
  });

  // 5. Handle amplify.yml
  await handleAmplifyYml(targetDir);

  console.log('\n✓ Blocks integrated with your Amplify Gen 2 app!\n');
  console.log('Next steps:');
  console.log('  npm run sandbox               # Deploy Amplify + Blocks to sandbox');
  console.log('  npm run blocks:dev            # Run Blocks local dev server\n');
  console.log('Your Blocks API is available at the /api endpoint alongside your Amplify backend.');
  console.log('');
  printMigrationInstructions();
}

function printMigrationInstructions() {
  console.log('─── Migration to Blocks-native (optional) ────────────────────────');
  console.log('');
  console.log('To make your app "Blocks-native with Amplify as a guest":');
  console.log('');
  console.log('1. Move CDK orchestration from amplify/backend.ts to aws-blocks/index.cdk.ts');
  console.log('   - Use BlocksStack.create() instead of BlocksBackend.create()');
  console.log('   - Import Amplify resources into the Blocks stack');
  console.log('');
  console.log('2. Run the sandbox through Blocks: change the `sandbox` script (now `npx ampx sandbox`)');
  console.log('   to `cdk-blocks sandbox`, then use `npm run sandbox`');
  console.log('   - Blocks sandbox uses CDK directly (no Amplify CLI dependency)');
  console.log('');
  console.log('3. Update amplify.yml to use CDK deploy directly:');
  console.log('   backend.phases.build.commands:');
  console.log('     - npx cdk deploy --require-approval never --app="npx tsx -C cdk aws-blocks/index.cdk.ts"');
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
 * `cdk-blocks dev` detects the project's frontend dev server from its dependencies.
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
  const workspaceRoot = await enclosingWorkspaceRoot(targetDir);
  console.log('\n🔍 Detected existing project (package.json found)\n');
  console.log('This will add AWS Blocks backend to your project:');
  console.log('');
  console.log('  CREATE  aws-blocks/           (Blocks backend workspace)');
  console.log('  CREATE  cdk.json              (CDK configuration)');
  console.log('  MODIFY  package.json          (adds workspace, deps, scripts)');
  console.log('  MODIFY  .gitignore            (adds Blocks entries)');
  console.log('');

  const proceed = skipConfirm || await confirm('Proceed?');
  if (!proceed) {
    console.log('Aborted.');
    process.exit(0);
  }

  console.log('\n📦 Adding Blocks backend...\n');

  // 1. Copy aws-blocks/ from the requested template. `cdk-blocks dev` detects the
  // project's own frontend dev server (`next dev` or `vite`) from its dependencies,
  // so only the template's backend settings are copied below.
  const templateDir = join(__dirname, '../templates', templateName);
  const awsBlocksSrc = join(templateDir, 'aws-blocks');
  const awsBlocksDest = join(targetDir, 'aws-blocks');

  if (await exists(awsBlocksDest)) {
    console.error('  ✗ aws-blocks/ already exists. Aborting to avoid overwriting.');
    process.exit(1);
  }

  await cp(awsBlocksSrc, awsBlocksDest, { recursive: true });

  // Generate blocks/config.json with a unique stackId
  const existingPkg = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf-8'));
  const baseName = (existingPkg.name || basename(resolve(targetDir)));
  const stackId = generateStackId(baseName);
  const blocksConfigDir = join(targetDir, '.blocks');
  await mkdir(blocksConfigDir, { recursive: true });
  await writeFile(join(blocksConfigDir, 'config.json'), JSON.stringify({ stackId }, null, 2));

  console.log('  ✓ Created aws-blocks/');

  // 2. Copy cdk.json
  const cdkJsonDest = join(targetDir, 'cdk.json');
  if (!(await exists(cdkJsonDest))) {
    await cp(join(templateDir, 'cdk.json'), cdkJsonDest);
    console.log('  ✓ Created cdk.json');
  } else {
    console.log('  ⚠ cdk.json already exists, skipping');
  }

  // 3. Add Blocks workspace (package.json, .gitignore, deps, install).
  // Source devDeps versions from the template's package.json — single source of truth.
  const templatePkg = JSON.parse(await readFile(join(templateDir, 'package.json'), 'utf-8'));
  const tplDevDeps = templatePkg.devDependencies || {};
  await addBlocksWorkspace(targetDir, {
    // The copied aws-blocks/ backend validates its API input with zod, at the template's version.
    deps: { '@aws-blocks/blocks': '*', ...(templatePkg.dependencies?.zod && { zod: templatePkg.dependencies.zod }) },
    devDeps: {
      'aws-cdk-lib': tplDevDeps['aws-cdk-lib'] || '2.257.0',
      'constructs': tplDevDeps['constructs'] || '^10.6.0',
      'tsx': tplDevDeps['tsx'] || '^4.7.0',
      'esbuild': tplDevDeps['esbuild'] || '^0.27.1',
      '@types/node': tplDevDeps['@types/node'] || '^20.0.0',
    },
    scripts: {
      'sandbox': 'cdk-blocks sandbox',
      'sandbox:destroy': 'cdk-blocks sandbox destroy',
      'sandbox:console': 'cdk-blocks sandbox console',
      'deploy': 'cdk-blocks deploy',
      'destroy': 'cdk-blocks destroy',
      'dev:server': 'cdk-blocks dev',
      'dev:stop': 'cdk-blocks dev stop',
    },
    blocksConfig: backendDevConfig(templatePkg.blocks),
    gitignoreEntries: ['.blocks-sandbox', 'cdk.out/', 'aws-blocks/client.js', 'aws-blocks/blocks.spec.json', '.bb-data/'],
    skipInstall,
    workspaceRoot,
  });

  console.log('\n✓ AWS Blocks backend added to your project!\n');
  console.log('Next steps:');
  console.log('  npm run sandbox         # Deploy backend to your AWS sandbox');
  console.log('  npm run dev:server      # Run local dev server');
  console.log('  npx --no -- cdk-blocks --help  # Every command of the cdk-blocks CLI (--no: never install from npm)');
  console.log('');
  console.log('Import your API in frontend code:');
  console.log('  import { api } from \'aws-blocks\'');
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

Create a new AWS Blocks app or add Blocks to an existing project.

The mode is auto-detected based on the target directory:

  1. Amplify project detected (amplify/backend.ts exists):
     Integrates Blocks into your Amplify Gen 2 backend.

  2. Existing project detected (package.json exists, no Amplify):
     Adds the aws-blocks/ backend workspace to your project.
     Works with any framework — Vite, Next.js, SvelteKit, Astro, etc.

  3. Empty or new directory:
     Creates a standalone Blocks starter app from a template. A directory
     that contains only benign metadata (e.g. .git, editor config) or an
     INSTRUCTIONS.md is still treated as empty; any other pre-existing file
     blocks scaffolding so it is never overwritten.

Arguments:
  directory              Target directory (default: ".")

Options:
  --template <name>      Template to use. For fresh projects it selects the
                         starter app; when adding to an existing project it
                         selects which aws-blocks/ workspace to copy, e.g.
                         "nextjs" for a Next.js dev server (default: "default")

                         Available templates: ${names.join(', ')}

${templateList}

                         Former names (still accepted): ${aliasList}

  --skip-install         Skip installing dependencies
  -y, --yes              Skip confirmation prompts
  -h, --help             Show this help message

Examples:
  npx @aws-blocks/create-blocks-app                            Add Blocks to current project
  npx @aws-blocks/create-blocks-app .                          Add Blocks to current project
  npx @aws-blocks/create-blocks-app my-app                     Create a standalone Blocks starter app
  npx @aws-blocks/create-blocks-app . --yes --template nextjs  Non-interactive scaffold with the Next.js template
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
    console.error('To add Blocks to an existing project, run from the project root:');
    console.error('  npx @aws-blocks/create-blocks-app');
    console.error('');
    console.error('To create a fresh Blocks app, specify a new directory:');
    console.error('  npx @aws-blocks/create-blocks-app my-app');
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
