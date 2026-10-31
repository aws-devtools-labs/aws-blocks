// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, execSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { resolveInput, findPackageJson } from './resolve.js';
import { generateBinShim, generatePackageJson, generateTsconfig, vendorBins } from './generate.js';
import { addToWorkspaces } from './workspace.js';
import { writeMigrationInstructions } from './instructions.js';
import { writeJson } from './fs.js';

const VENDOR_DIR = 'vendor';

export interface VendorizeOptions {
  force?: boolean;
}

/** A failure reported to the user as-is (one line per entry) before exiting with code 1. */
class VendorizeError extends Error {
  constructor(readonly lines: string[]) {
    super(lines[0]);
  }
}

/** A package directory to copy from, plus cleanup for a temporary download. */
interface PackageSource {
  dir: string;
  cleanup(): void;
}

export function vendorize(input: string, options: VendorizeOptions = {}): void {
  const projectRoot = findProjectRoot();
  const { packageName, packageJsonPath } = resolveInput(input);
  const shortName = packageName.replace(/^@[^/]+\//, '');
  const destDir = join(projectRoot, VENDOR_DIR, shortName);

  // Check if already vendorized
  if (existsSync(destDir) && !options.force) {
    console.error(`Error: ${packageName} is already vendorized at ${VENDOR_DIR}/${shortName}/`);
    console.error('Use --force to remove the existing copy and re-vendorize from the published source.');
    process.exit(1);
  }

  const source = orExit(() => locateSource(projectRoot, packageName, packageJsonPath, destDir));
  if (existsSync(destDir)) console.log(`Replacing existing ${VENDOR_DIR}/${shortName}/ (--force)...`);
  orExit(() => copyIntoVendor(projectRoot, source.dir, packageName, shortName), source.cleanup);
  source.cleanup();

  // Remove any nested copy of this package inside the umbrella blocks package.
  // npm may install a nested copy if versions don't align. Removing it forces
  // Node to resolve through the hoisted workspace symlink.
  const blocksPkgJson = findPackageJson('@aws-blocks/blocks');
  if (blocksPkgJson) {
    const blocksDir = dirname(blocksPkgJson);
    const nestedPath = join(blocksDir, 'node_modules', ...packageName.split('/'));
    if (existsSync(nestedPath)) {
      rmSync(nestedPath, { recursive: true });
    }
  }

  console.log('');
  console.log(`✅ Vendorized ${packageName}`);
  console.log(`   Source: ${VENDOR_DIR}/${shortName}/src/`);
  console.log(`   Migration notes: ${VENDOR_DIR}/${shortName}/VENDORIZE.md`);
}

/**
 * Pick the package to copy from, before anything under vendor/ changes.
 *
 * Once a package is vendorized, `node_modules/<pkg>` links to `vendor/<pkg>`
 * itself, so re-vendorizing downloads the published tarball of the vendored
 * version instead.
 */
function locateSource(projectRoot: string, packageName: string, packageJsonPath: string, destDir: string): PackageSource {
  const installedDir = realpathSync(dirname(packageJsonPath));
  if (!existsSync(destDir) || !isInside(installedDir, realpathSync(destDir))) {
    return { dir: installedDir, cleanup: () => {} };
  }

  const shortName = packageName.replace(/^@[^/]+\//, '');
  const version: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf-8')).version;
  if (typeof version !== 'string' || version === '') {
    throw new VendorizeError([
      `Error: ${VENDOR_DIR}/${shortName}/package.json has no "version", so the published version to re-vendorize from is unknown.`,
      `Nothing was changed. Set "version" in ${VENDOR_DIR}/${shortName}/package.json and run the command again.`,
    ]);
  }

  console.log(`node_modules/${packageName} is the vendorized copy; downloading the published ${packageName}@${version}...`);
  return downloadPublished(projectRoot, packageName, version, shortName);
}

/** `npm pack` the published `<packageName>@<version>` into a temp dir and unpack it. */
function downloadPublished(projectRoot: string, packageName: string, version: string, shortName: string): PackageSource {
  const tempDir = mkdtempSync(join(tmpdir(), 'blocks-vendorize-'));
  const cleanup = () => rmSync(tempDir, { recursive: true, force: true });
  try {
    // Run from the app so its .npmrc (registry, auth) applies.
    execSync(`npm pack ${JSON.stringify(`${packageName}@${version}`)} --pack-destination ${JSON.stringify(tempDir)}`, {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    const tarball = readdirSync(tempDir).find(name => name.endsWith('.tgz'));
    if (!tarball) throw new Error(`npm pack ${packageName}@${version} produced no tarball`);
    execFileSync('tar', ['-xzf', tarball], { cwd: tempDir, stdio: 'pipe' });
    return { dir: join(tempDir, 'package'), cleanup };
  } catch (err) {
    cleanup();
    throw new VendorizeError([
      `Error: Could not download the published ${packageName}@${version} to re-vendorize from.`,
      ...errorDetail(err),
      `Nothing was changed: ${VENDOR_DIR}/${shortName}/ is untouched.`,
    ]);
  }
}

/**
 * Build the vendored copy in a staging directory, then swap it in for
 * vendor/<pkg> and re-link. On any failure the previous vendor/<pkg> (if any)
 * and the root package.json are restored.
 */
function copyIntoVendor(projectRoot: string, sourceDir: string, packageName: string, shortName: string): void {
  const srcDir = join(sourceDir, 'src');
  if (!existsSync(srcDir)) {
    throw new VendorizeError([
      `Error: Package ${packageName} does not include src/ directory.`,
      'Only packages with published source can be vendorized.',
    ]);
  }

  const originalPkg = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf-8'));
  const appPkgPath = join(projectRoot, 'package.json');
  const appPkgBefore = readFileSync(appPkgPath, 'utf-8');
  const appPkg = JSON.parse(appPkgBefore);
  const vendorRoot = join(projectRoot, VENDOR_DIR);
  const destDir = join(vendorRoot, shortName);

  console.log(`Vendorizing ${packageName} → ${VENDOR_DIR}/${shortName}/`);

  mkdirSync(vendorRoot, { recursive: true });
  const workDir = mkdtempSync(join(vendorRoot, '.vendorize-'));
  const stagingDir = join(workDir, 'new');
  const backupDir = join(workDir, 'old');
  let movedOld = false;
  let movedNew = false;
  let installing = false;
  try {
    cpSync(srcDir, join(stagingDir, 'src'), { recursive: true });
    const bins = vendorBins(originalPkg).filter(bin => existsSync(join(stagingDir, bin.entry)));
    for (const bin of bins) {
      mkdirSync(dirname(join(stagingDir, bin.shim)), { recursive: true });
      writeFileSync(join(stagingDir, bin.shim), generateBinShim(bin), { mode: 0o755 });
    }
    const tsxRange: string | undefined = appPkg.dependencies?.tsx ?? appPkg.devDependencies?.tsx;
    writeJson(join(stagingDir, 'package.json'), generatePackageJson(originalPkg, bins, tsxRange));
    writeJson(join(stagingDir, 'tsconfig.json'), generateTsconfig());
    writeMigrationInstructions(stagingDir, packageName, shortName, bins.map(bin => bin.name));

    if (existsSync(destDir)) {
      renameSync(destDir, backupDir);
      movedOld = true;
    }
    renameSync(stagingDir, destDir);
    movedNew = true;
    addToWorkspaces(projectRoot, `${VENDOR_DIR}/${shortName}`);

    console.log('Re-linking workspaces...');
    installing = true;
    execSync('npm install', { cwd: projectRoot, stdio: 'inherit' });
  } catch (err) {
    if (movedNew) rmSync(destDir, { recursive: true, force: true });
    if (movedOld) renameSync(backupDir, destDir);
    writeFileSync(appPkgPath, appPkgBefore);
    rmSync(workDir, { recursive: true, force: true });
    throw new VendorizeError([
      `Error: Could not vendorize ${packageName}.`,
      ...errorDetail(err),
      movedOld
        ? `Restored the previous ${VENDOR_DIR}/${shortName}/ and package.json.`
        : `Removed the partial ${VENDOR_DIR}/${shortName}/ and restored package.json.`,
      ...(installing ? ['Run `npm install` to re-link node_modules.'] : []),
    ]);
  }
  rmSync(workDir, { recursive: true, force: true });
}

/** Run a step; on a {@link VendorizeError}, run `cleanup`, print the error and exit with code 1. */
function orExit<T>(step: () => T, cleanup?: () => void): T {
  try {
    return step();
  } catch (err) {
    cleanup?.();
    if (!(err instanceof VendorizeError)) throw err;
    for (const line of err.lines) console.error(line);
    process.exit(1);
  }
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel));
}

/** The useful lines of a failed step: a child process's stderr, else the error message. */
function errorDetail(err: unknown): string[] {
  const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr ?? '') : '';
  const text = stderr.trim() || (err instanceof Error ? err.message : String(err));
  return text.split('\n').filter(line => line.trim() !== '').map(line => `  ${line}`);
}

function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== dirname(dir)) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      const content = JSON.parse(readFileSync(pkg, 'utf-8'));
      if (content.workspaces) return dir;
    }
    dir = dirname(dir);
  }
  console.error('Error: Could not find a workspace root (no package.json with "workspaces" field found).');
  console.error('Run this command from within a project that uses npm workspaces.');
  process.exit(1);
}
