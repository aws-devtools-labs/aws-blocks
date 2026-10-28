// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Checks that all aws-blocks/package.json files in the repo have consistent
 * export conditions required for SSR (react-server, import).
 *
 * Required conditions in exports["."] :
 *   - types    → ./.types/index.d.ts in create-blocks-app templates (the
 *                backend's generated declarations, so a frontend never
 *                typechecks the backend source with its own tsconfig);
 *                ./index.ts or ./.types/index.d.ts in test-apps. Both stay
 *                valid: apps scaffolded earlier point at the source, and a
 *                missing .types/ file falls back to the source.
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

const GENERATED_TYPES = "./.types/index.d.ts";
const TYPES_TSCONFIG = "tsconfig.types.json";

const REQUIRED_CONDITIONS: Record<string, string> = {
  types: GENERATED_TYPES,
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

  const isTemplate = relPath.startsWith("packages/create-blocks-app/templates/");
  for (const [condition, expectedValue] of Object.entries(REQUIRED_CONDITIONS)) {
    const accepted = condition === "types" && !isTemplate ? [expectedValue, "./index.ts"] : [expectedValue];
    if (!(condition in dot)) {
      errors.push(`${relPath}: missing condition "${condition}"`);
    } else if (!accepted.includes(dot[condition])) {
      errors.push(
        `${relPath}: condition "${condition}" is "${dot[condition]}", expected ${accepted.map((v) => `"${v}"`).join(" or ")}`
      );
    }
  }

  return errors;
}

/**
 * Strips `//` and block comments that sit outside strings, so a commented
 * tsconfig (JSONC, which is what we ship) can go through `JSON.parse`.
 */
function stripJsonComments(src: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }

  return out;
}

/**
 * Every template's `aws-blocks/tsconfig.types.json` must be the same config.
 *
 * It is duplicated per template with no shared constant behind it (the exported
 * `BACKEND_TYPES_TSCONFIG` is only the file *name*), so these copies are the
 * source of truth for the settings the generated declarations are built with.
 * Drift between them would mean two scaffolded apps emit different `.types/`
 * from identical backend source. `generate-types.test.ts` mirrors this config
 * in its fixture so the generator is exercised against what customers get.
 *
 * Also checks the pairing `backendTypesTarget()` requires: a template pointing
 * `exports["."].types` at the generated declarations but shipping no
 * `tsconfig.types.json` would skip generation silently, forever.
 */
function checkTemplateTypesTsconfigs(): string[] {
  const errors: string[] = [];
  const templatesDir = join(ROOT, "packages/create-blocks-app/templates");

  let templates: string[];
  try {
    templates = readdirSync(templatesDir, { withFileTypes: true })
      .filter((t) => t.isDirectory())
      .map((t) => t.name)
      .sort();
  } catch {
    return errors;
  }

  const configs = new Map<string, string>();

  for (const name of templates) {
    const relPath = join("packages/create-blocks-app/templates", name, "aws-blocks", TYPES_TSCONFIG);
    const pkgRelPath = join("packages/create-blocks-app/templates", name, "aws-blocks/package.json");

    let usesGeneratedTypes = false;
    try {
      const pkg = JSON.parse(readFileSync(resolve(ROOT, pkgRelPath), "utf-8"));
      usesGeneratedTypes = pkg?.exports?.["."]?.types === GENERATED_TYPES;
    } catch {
      continue; // no aws-blocks workspace in this template
    }

    let raw: string;
    try {
      raw = readFileSync(resolve(ROOT, relPath), "utf-8");
    } catch {
      if (usesGeneratedTypes) {
        errors.push(
          `${pkgRelPath}: exports["."].types is "${GENERATED_TYPES}" but ${TYPES_TSCONFIG} is missing, so the declarations are never generated`
        );
      }
      continue;
    }

    if (!usesGeneratedTypes) {
      errors.push(`${relPath}: ships ${TYPES_TSCONFIG} but exports["."].types does not point at "${GENERATED_TYPES}"`);
    }

    try {
      configs.set(relPath, JSON.stringify(JSON.parse(stripJsonComments(raw))));
    } catch {
      errors.push(`${relPath}: invalid JSON`);
    }
  }

  const distinct = new Set(configs.values());
  if (distinct.size > 1) {
    errors.push(
      `${TYPES_TSCONFIG} differs between templates (${distinct.size} variants across ${configs.size} files); they must all carry the same config:`
    );
    for (const [relPath, config] of configs) errors.push(`    ${relPath}: ${config}`);
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

  const exportErrorCount = allErrors.length;

  const tsconfigErrors = checkTemplateTypesTsconfigs();
  if (tsconfigErrors.length === 0) {
    console.log(`  ✓ template ${TYPES_TSCONFIG} files agree`);
  } else {
    console.log(`  ✗ template ${TYPES_TSCONFIG} files`);
    allErrors.push(...tsconfigErrors);
  }

  console.log();

  if (allErrors.length > 0) {
    console.error("ERRORS:");
    for (const err of allErrors) {
      console.error(`  • ${err}`);
    }
    if (exportErrorCount > 0) {
      console.error(
        `\nAll aws-blocks/package.json files must have these export conditions:`
      );
      for (const [condition, value] of Object.entries(REQUIRED_CONDITIONS)) {
        console.error(`  "${condition}": "${value}"`);
      }
    }
    process.exit(1);
  }

  console.log("All aws-blocks export maps are consistent. ✓");
}

main();
