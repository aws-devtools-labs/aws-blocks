// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveInput, findPackageJson } from './resolve.js';
import { generatePackageJson, generateTsconfig } from './generate.js';
import { addToWorkspaces } from './workspace.js';
import { writeMigrationInstructions } from './instructions.js';
import { writeJson } from './fs.js';

const VENDOR_DIR = 'vendor';

export interface VendorizeOptions {
  force?: boolean;
}

export function vendorize(input: string, options: VendorizeOptions = {}): void {
  const projectRoot = findProjectRoot();
  const { packageName, packageJsonPath } = resolveInput(input);
  const shortName = packageName.replace(/^@[^/]+\//, '');
  const destDir = join(projectRoot, VENDOR_DIR, shortName);

  // Check if already vendorized
  if (existsSync(destDir)) {
    if (!options.force) {
      console.error(`Error: ${packageName} is already vendorized at ${VENDOR_DIR}/${shortName}/`);
      console.error('Use --force to remove the existing copy and re-vendorize from the published source.');
      process.exit(1);
    }
    console.log(`Removing existing ${VENDOR_DIR}/${shortName}/ (--force)...`);
    rmSync(destDir, { recursive: true });
  }

  const pkgDir = dirname(packageJsonPath);
  const srcDir = join(pkgDir, 'src');

  if (!existsSync(srcDir)) {
    console.error(`Error: Package ${packageName} does not include src/ directory.`);
    console.error('Only packages with published source can be vendorized.');
    process.exit(1);
  }

  const originalPkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

  console.log(`Vendorizing ${packageName} → ${VENDOR_DIR}/${shortName}/`);

  mkdirSync(destDir, { recursive: true });
  cpSync(srcDir, join(destDir, 'src'), { recursive: true });
  writeJson(join(destDir, 'package.json'), generatePackageJson(originalPkg));
  writeJson(join(destDir, 'tsconfig.json'), generateTsconfig());

  addToWorkspaces(projectRoot, `${VENDOR_DIR}/${shortName}`);

  console.log('Re-linking workspaces...');
  execSync('npm install', { cwd: projectRoot, stdio: 'inherit' });

  // Remove any nested copy of this package inside the umbrella blocks package.
  // npm may install a nested copy if versions don't align. Removing it forces
  // Node to resolve through the hoisted workspace symlink.
  const blocksPkgJson = findPackageJson('aws-cdk-blocks');
  if (blocksPkgJson) {
    const blocksDir = dirname(blocksPkgJson);
    const nestedPath = join(blocksDir, 'node_modules', ...packageName.split('/'));
    if (existsSync(nestedPath)) {
      rmSync(nestedPath, { recursive: true });
    }
  }

  writeMigrationInstructions(destDir, packageName, shortName);

  console.log('');
  console.log(`✅ Vendorized ${packageName}`);
  console.log(`   Source: ${VENDOR_DIR}/${shortName}/src/`);
  console.log(`   Migration notes: ${VENDOR_DIR}/${shortName}/VENDORIZE.md`);
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
