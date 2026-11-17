// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Checks that every Building Block whose `exports["."]` declares an
 * `aws-runtime` condition calls `assertNotMockInDeployedEnv('<package dir>')`
 * at the top level of the source behind its `default` (mock) entry, and that
 * the create-block scaffold template does the same with its package-name
 * token. A dropped call is not a build or test failure on its own, so it needs
 * a static guard.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const PACKAGES_DIR = join(ROOT, "packages");

/** Scaffold template mock entry + the token create-block substitutes into it. */
const TEMPLATE_MOCK = "packages/create-block/templates/primitive/src/index.mock.ts";
const TEMPLATE_TOKEN = "__BB_PKG_NAME__";

/** Matches a column-0 (top-level) guard call and captures its name argument. */
const TOP_LEVEL_CALL = /^assertNotMockInDeployedEnv\(\s*(['"])([^'"]*)\1\s*\)\s*;?/gm;

/** Resolve an export condition value to its target path (handles `{ types, default }` objects). */
function conditionTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "default" in value) {
    return conditionTarget((value as Record<string, unknown>).default);
  }
  return undefined;
}

/** `./dist/index.mock.js` → `src/index.mock.ts`. */
function distToSource(target: string): string {
  return target.replace(/^\.\//, "").replace(/^dist\//, "src/").replace(/\.js$/, ".ts");
}

/** Returns an error string, or undefined when `file` calls the guard with exactly `expected`. */
function checkFile(rel: string, expected: string): string | undefined {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return `${rel}: source for the default (mock) entry not found`;
  const names = [...readFileSync(abs, "utf-8").matchAll(TOP_LEVEL_CALL)].map((m) => m[2]);
  if (names.length === 0) {
    return `${rel}: missing top-level assertNotMockInDeployedEnv('${expected}') call`;
  }
  if (!names.includes(expected)) {
    return `${rel}: assertNotMockInDeployedEnv called with '${names.join("', '")}', expected '${expected}'`;
  }
  return undefined;
}

function main() {
  const offenders: string[] = [];
  let checked = 0;

  const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const dir of dirs) {
    const pkgPath = join(PACKAGES_DIR, dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const dot = pkg.exports?.["."];
    if (!dot || typeof dot !== "object" || !("aws-runtime" in dot)) continue;

    checked++;
    const target = conditionTarget(dot.default);
    if (!target) {
      console.log(`  ✗ packages/${dir}`);
      offenders.push(`packages/${dir}/package.json: exports["."] has aws-runtime but no default target`);
      continue;
    }
    const rel = join("packages", dir, distToSource(target));
    const err = checkFile(rel, dir);
    if (err) {
      console.log(`  ✗ ${rel}`);
      offenders.push(err);
    } else {
      console.log(`  ✓ ${rel}`);
    }
  }

  checked++;
  const templateErr = checkFile(TEMPLATE_MOCK, TEMPLATE_TOKEN);
  if (templateErr) {
    console.log(`  ✗ ${TEMPLATE_MOCK}`);
    offenders.push(templateErr);
  } else {
    console.log(`  ✓ ${TEMPLATE_MOCK}`);
  }

  console.log();

  if (checked <= 1) {
    console.error("ERROR: found no Building Block with an aws-runtime export condition to check.");
    process.exit(1);
  }

  if (offenders.length > 0) {
    console.error("ERRORS:");
    for (const err of offenders) {
      console.error(`  • ${err}`);
    }
    console.error(
      "\nEvery Building Block mock (default) entry must fail closed in a deployed env. Add, at the top " +
        "level after the imports:\n  assertNotMockInDeployedEnv('<package dir name>');"
    );
    process.exit(1);
  }

  console.log(`All ${checked} mock entr${checked === 1 ? "y" : "ies"} call assertNotMockInDeployedEnv.`);
}

main();
