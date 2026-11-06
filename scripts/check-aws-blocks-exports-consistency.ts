// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Checks that all aws-blocks/package.json files in the repo have consistent
 * export conditions required for SSR (react-server, import).
 *
 * Required conditions in exports["."] :
 *   - types    → ./index.ts
 *   - browser  → ./client.js
 *   - react-server → ./client.js
 *   - import   → ./client.js
 *   - default  → ./index.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const REQUIRED_CONDITIONS: Record<string, string> = {
  types: "./index.ts",
  browser: "./client.js",
  "react-server": "./client.js",
  import: "./client.js",
  default: "./index.ts",
};

function findAwsBlocksPackageJsons(): string[] {
  const results: string[] = [];

  // Check create-blocks-app templates
  const templatesDir = join(ROOT, "packages/create-blocks-app/templates");
  try {
    const templates = readdirSync(templatesDir, { withFileTypes: true });
    for (const t of templates) {
      if (t.isDirectory()) {
        const pkgPath = join("packages/create-blocks-app/templates", t.name, "aws-blocks/package.json");
        try {
          readFileSync(resolve(ROOT, pkgPath));
          results.push(pkgPath);
        } catch {
          // file doesn't exist in this template
        }
      }
    }
  } catch {
    // templates dir not found
  }

  // Check test-apps
  const testAppsDir = join(ROOT, "test-apps");
  try {
    const apps = readdirSync(testAppsDir, { withFileTypes: true });
    for (const a of apps) {
      if (a.isDirectory()) {
        const pkgPath = join("test-apps", a.name, "aws-blocks/package.json");
        try {
          readFileSync(resolve(ROOT, pkgPath));
          results.push(pkgPath);
        } catch {
          // file doesn't exist in this test-app
        }
      }
    }
  } catch {
    // test-apps dir not found
  }

  return results.sort();
}

function checkFile(relPath: string): string[] {
  const errors: string[] = [];
  const absPath = resolve(ROOT, relPath);

  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch {
    errors.push(`Cannot read file: ${relPath}`);
    return errors;
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content);
  } catch {
    errors.push(`Invalid JSON: ${relPath}`);
    return errors;
  }

  const exports = pkg.exports as Record<string, unknown> | undefined;
  if (!exports) {
    errors.push(`${relPath}: missing "exports" field`);
    return errors;
  }

  const dot = exports["."] as Record<string, string> | undefined;
  if (!dot) {
    errors.push(`${relPath}: missing exports["."]`);
    return errors;
  }

  for (const [condition, expectedValue] of Object.entries(REQUIRED_CONDITIONS)) {
    if (!(condition in dot)) {
      errors.push(`${relPath}: missing condition "${condition}"`);
    } else if (dot[condition] !== expectedValue) {
      errors.push(
        `${relPath}: condition "${condition}" is "${dot[condition]}", expected "${expectedValue}"`
      );
    }
  }

  return errors;
}

function main() {
  const files = findAwsBlocksPackageJsons();

  if (files.length === 0) {
    console.error("ERROR: No aws-blocks/package.json files found!");
    process.exit(1);
  }

  console.log(`Checking ${files.length} aws-blocks package.json files...\n`);

  const allErrors: string[] = [];

  for (const file of files) {
    const errors = checkFile(file);
    if (errors.length === 0) {
      console.log(`  ✓ ${file}`);
    } else {
      console.log(`  ✗ ${file}`);
      allErrors.push(...errors);
    }
  }

  console.log();

  if (allErrors.length > 0) {
    console.error("ERRORS:");
    for (const err of allErrors) {
      console.error(`  • ${err}`);
    }
    console.error(
      `\nAll aws-blocks/package.json files must have these export conditions:`
    );
    for (const [condition, value] of Object.entries(REQUIRED_CONDITIONS)) {
      console.error(`  "${condition}": "${value}"`);
    }
    process.exit(1);
  }

  console.log("All aws-blocks export maps are consistent. ✓");
}

main();
