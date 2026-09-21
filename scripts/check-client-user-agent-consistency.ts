// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Checks that every Building Block (packages/bb-*) configuring an AWS SDK client
 * with `customUserAgent` also calls `installClientUserAgent`. A missed site is
 * silently unattributed native traffic, not a build error, so it needs a guard.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const PACKAGES_DIR = join(ROOT, "packages");

function walkTsFiles(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walkTsFiles(full, acc);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
}

function isBuildingBlockSource(absPath: string): boolean {
  const rel = absPath.slice(PACKAGES_DIR.length + 1);
  if (!rel.startsWith("bb-")) return false; // only Building Blocks consume the helper
  if (rel.includes("/templates/")) return false; // commented example, not a real client
  return true;
}

/**
 * Counts `customUserAgent` client-construction sites in a file, ignoring type
 * fields, reassignments, and options merely forwarded to a non-client helper.
 */
function countClientUserAgentSites(content: string): number {
  let sites = 0;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
    if (/\bcustomUserAgent\s*[:,}]/.test(line)) sites++;
  }
  if (sites === 0) return 0;
  return /new\s+[A-Z]\w*Client\s*\(/.test(content) ? sites : 0;
}

function countInstalls(content: string): number {
  return (content.match(/installClientUserAgent\s*\(/g) ?? []).length;
}

function main() {
  const files: string[] = [];
  walkTsFiles(PACKAGES_DIR, files);
  const sources = files.filter(isBuildingBlockSource).sort();

  const offenders: string[] = [];
  let checked = 0;

  for (const abs of sources) {
    const content = readFileSync(abs, "utf-8");
    const sites = countClientUserAgentSites(content);
    if (sites === 0) continue;
    checked += sites;
    const rel = abs.slice(ROOT.length + 1);
    const installs = countInstalls(content);
    if (installs >= sites) {
      console.log(`  ✓ ${rel} (${sites} site${sites > 1 ? "s" : ""})`);
    } else {
      console.log(`  ✗ ${rel}`);
      offenders.push(`${rel}: ${sites} customUserAgent site(s) but only ${installs} installClientUserAgent() call(s)`);
    }
  }

  console.log();

  if (checked === 0) {
    console.error("ERROR: found no Building Block client-construction sites to check.");
    process.exit(1);
  }

  if (offenders.length > 0) {
    console.error("ERRORS:");
    for (const err of offenders) {
      console.error(`  • ${err}`);
    }
    console.error(
      "\nEvery SDK client configured with customUserAgent must also install the " +
        "native client user-agent middleware:\n  installClientUserAgent(client);"
    );
    process.exit(1);
  }

  console.log(`All ${checked} Building Block client site(s) install the user-agent middleware. ✓`);
}

main();
