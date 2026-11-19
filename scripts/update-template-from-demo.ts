// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0


import { cp, readFile, writeFile, rename, rm, mkdir } from 'fs/promises';
import { join, resolve, dirname, basename } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(__dirname, '../packages/create-blocks-app/templates');
const demoAppsDir = resolve(__dirname, '../blocks-demo-apps');

async function main() {
  if (!existsSync(demoAppsDir)) {
    console.log('Demo apps directory not found, skipping template update');
    return;
  }
  
  // Find all demo apps
  const { readdirSync, statSync } = await import('fs');
  const apps = readdirSync(demoAppsDir).filter(name => {
    const path = join(demoAppsDir, name);
    return statSync(path).isDirectory();
  });
  
  for (const appName of apps) {
    const appDir = join(demoAppsDir, appName);
    const pkgPath = join(appDir, 'package.json');
    
    if (!existsSync(pkgPath)) continue;
    
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    const templateName = pkg.blocksTemplate;
    
    if (!templateName) {
      console.log(`Skipping ${appName}: no blocksTemplate property`);
      continue;
    }
    
    const templateDir = join(templatesDir, templateName);
    
    console.log(`Updating template '${templateName}' from ${appName}...`);
    
    if (existsSync(templateDir)) {
      await rm(templateDir, { recursive: true });
    }
    await mkdir(templateDir, { recursive: true });
    
    await cp(appDir, templateDir, {
      recursive: true,
      filter: (src) => {
        const rel = src.replace(appDir, '');
        return !rel.match(/^(\/node_modules|\/\.cdk-blocks-sandbox|\/cdk\.out|\/dist|\/build|\/package-lock\.json)/);
      }
    });
    
    const templatePkgPath = join(templateDir, 'package.json');
    const templatePkg = JSON.parse(await readFile(templatePkgPath, 'utf-8'));
    
    // Reverse all file: paths to workspace:*
    for (const dep of Object.keys(templatePkg.dependencies || {})) {
      if (templatePkg.dependencies[dep].startsWith('file:')) {
        templatePkg.dependencies[dep] = 'workspace:*';
      }
    }
    
    await writeFile(templatePkgPath, JSON.stringify(templatePkg, null, 2) + '\n');
    await rename(join(templateDir, '.gitignore'), join(templateDir, 'gitignore'));
    
    console.log(`✓ Template '${templateName}' updated`);
  }
}

main().catch(console.error);