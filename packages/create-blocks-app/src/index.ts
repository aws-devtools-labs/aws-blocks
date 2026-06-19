#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, readFile, writeFile, rename, access, readdir } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { trackCommand } from './telemetry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

async function isEmptyDir(dir: string): Promise<boolean> {
  if (!(await exists(dir))) return true;
  const entries = await readdir(dir);
  return entries.length === 0;
}

async function isAmplifyGen2Project(dir: string): Promise<boolean> {
  return exists(join(dir, 'amplify', 'backend.ts'));
}

/**
 * Copies shared resources (maintained once in `resources/`) into the scaffolded project.
 */
async function copySharedResources(targetDir: string): Promise<void> {
  const resourcesDir = join(__dirname, '../resources');
  await cp(join(resourcesDir, 'AGENTS.md'), join(targetDir, 'AGENTS.md'));
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
 * - Patching .gitignore
 * - Monorepo detection and file: path rewriting
 * - Running npm install
 */
async function addBlocksWorkspace(targetDir: string, options: {
  devDeps: Record<string, string>;
  deps: Record<string, string>;
  scripts: Record<string, string>;
  gitignoreEntries: string[];
  skipInstall?: boolean;
}): Promise<void> {
  const { devDeps, deps, scripts, gitignoreEntries, skipInstall } = options;

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
  if (!skipInstall) {
    console.log('\nInstalling dependencies...');
    execSync('npm install', { cwd: targetDir, stdio: 'inherit' });
  }
}

const AVAILABLE_TEMPLATES = ['default', 'bare', 'react', 'backend', 'nextjs', 'auth-cognito', 'amplify', 'demo'];

function validateTemplateName(templateName: string): void {
  if (!AVAILABLE_TEMPLATES.includes(templateName)) {
    console.error(`Error: Unknown template "${templateName}".`);
    console.error(`Available templates: ${AVAILABLE_TEMPLATES.join(', ')}`);
    process.exit(1);
  }
}

// ─── Fresh project creation ──────────────────────────────────────────────────

async function createFreshProject(targetDir: string, templateName: string) {
  validateTemplateName(templateName);

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
  
  // Update stack name in CDK file — sanitize for CDK-safe IDs
  const cdkPath = join(targetDir, 'aws-blocks/index.cdk.ts');
  let cdkContent = await readFile(cdkPath, 'utf-8');
  let sanitizedName = appName
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/^[^A-Za-z]+/, 'app-')
    .replace(/-+/g, '-')
    .replace(/-$/, '') || 'blocks-app';
  cdkContent = cdkContent.replace(/my-blocks-stack/g, `${sanitizedName}-stack`);
  await writeFile(cdkPath, cdkContent);
  
  console.log('Installing dependencies...');
  execSync('npm install', { cwd: targetDir, stdio: 'inherit' });
  
  console.log('\n✓ Blocks app created!');
  console.log(`\nNext steps:`);
  console.log(`  cd ${targetDir}`);
  console.log(`  npm run dev`);
  console.log(`\nThen open http://localhost:3000`);
  console.log(`\nSee README.md for an overview and AGENTS.md for AI agent instructions.`);
}

// ─── Amplify Gen 2 integration ──────────────────────────────────────────────

async function integrateWithAmplify(targetDir: string, skipConfirm = false, skipInstall = false) {
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
      'blocks:dev': 'tsx watch aws-blocks/scripts/server.ts',
      'blocks:generate-client': 'cross-env NODE_OPTIONS="--conditions=aws-runtime" tsx aws-blocks/scripts/generate-client.ts',
    },
    gitignoreEntries: ['.blocks-sandbox'],
    skipInstall,
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
  console.log('2. Replace `npx ampx sandbox` with `npm run sandbox`');
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

async function integrateWithExistingProject(targetDir: string, skipConfirm = false, skipInstall = false) {
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

  // 1. Copy aws-blocks/ from the default template (reuses the same source of truth)
  const templateDir = join(__dirname, '../templates/default');
  const awsBlocksSrc = join(templateDir, 'aws-blocks');
  const awsBlocksDest = join(targetDir, 'aws-blocks');

  if (await exists(awsBlocksDest)) {
    console.error('  ✗ aws-blocks/ already exists. Aborting to avoid overwriting.');
    process.exit(1);
  }

  await cp(awsBlocksSrc, awsBlocksDest, { recursive: true });

  // Derive a CDK-safe app name from the directory basename for stack naming.
  // CDK stack IDs must match /^[A-Za-z][A-Za-z0-9-]*$/.
  let appName = basename(resolve(targetDir));
  appName = appName
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/^[^A-Za-z]+/, 'app-')
    .replace(/-+/g, '-')
    .replace(/-$/, '') || 'blocks-app';
  const cdkPath = join(awsBlocksDest, 'index.cdk.ts');
  let cdkContent = await readFile(cdkPath, 'utf-8');
  cdkContent = cdkContent.replace(/my-blocks-stack/g, `${appName}-stack`);
  await writeFile(cdkPath, cdkContent);

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
    deps: { '@aws-blocks/blocks': '*' },
    devDeps: {
      'aws-cdk-lib': tplDevDeps['aws-cdk-lib'] || '2.257.0',
      'constructs': tplDevDeps['constructs'] || '^10.6.0',
      'tsx': tplDevDeps['tsx'] || '^4.7.0',
      'esbuild': tplDevDeps['esbuild'] || '^0.27.1',
      '@types/node': tplDevDeps['@types/node'] || '^20.0.0',
    },
    scripts: {
      'sandbox': 'tsx aws-blocks/scripts/sandbox.ts',
      'sandbox:destroy': 'tsx -C cdk aws-blocks/scripts/sandbox-destroy.ts',
      'sandbox:console': 'tsx aws-blocks/scripts/console.ts',
      'deploy': 'tsx aws-blocks/scripts/deploy.ts',
      'destroy': 'tsx aws-blocks/scripts/destroy.ts',
      'dev:server': 'tsx watch aws-blocks/scripts/server.ts',
    },
    gitignoreEntries: ['.blocks-sandbox', 'cdk.out/', 'aws-blocks/client.js', 'aws-blocks/blocks.spec.json'],
    skipInstall,
  });

  console.log('\n✓ AWS Blocks backend added to your project!\n');
  console.log('Next steps:');
  console.log('  npm run sandbox         # Deploy backend to your AWS sandbox');
  console.log('  npm run dev:server      # Run local dev server');
  console.log('');
  console.log('Import your API in frontend code:');
  console.log('  import { api } from \'aws-blocks\'');
  console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`Usage: create-blocks-app [directory] [options]

Create a new AWS Blocks app or add Blocks to an existing project.

The mode is auto-detected based on the target directory:

  1. Amplify project detected (amplify/backend.ts exists):
     Integrates Blocks into your Amplify Gen 2 backend.

  2. Existing project detected (package.json exists, no Amplify):
     Adds the aws-blocks/ backend workspace to your project.
     Works with any framework — Vite, Next.js, SvelteKit, Astro, etc.

  3. Empty or new directory:
     Creates a standalone Blocks starter app from a template.

Arguments:
  directory              Target directory (default: ".")

Options:
  --template <name>      Template to use for fresh projects (default: "default")
  -y, --yes              Skip confirmation prompts
  -h, --help             Show this help message

Examples:
  npx @aws-blocks/create-blocks-app            Add Blocks to current project
  npx @aws-blocks/create-blocks-app .          Add Blocks to current project
  npx @aws-blocks/create-blocks-app my-app     Create a standalone Blocks starter app
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
      printUsage();
      process.exit(0);
    } else if (args[i] === '--template' && i + 1 < args.length) {
      templateName = args[i + 1];
      i++;
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

  validateTemplateName(templateName);

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
      await integrateWithExistingProject(resolvedDir, skipConfirm, skipInstall);
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
      await createFreshProject(resolve(targetDir), templateName);
      return;
    }

    // None of the above — error
    console.error('Error: Target directory is not empty and no package.json found.');
    console.error('');
    console.error('To add Blocks to an existing project, run from the project root:');
    console.error('  npx @aws-blocks/create-blocks-app');
    console.error('');
    console.error('To create a fresh Blocks app, specify a new directory:');
    console.error('  npx @aws-blocks/create-blocks-app my-app');
    process.exit(1);
  }, { template: templateName, templateVersion: templatePkgVersion });
}

create().catch(console.error);
