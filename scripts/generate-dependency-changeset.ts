// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Write a changeset for an automated dependency bump so the `Require changeset`
 * gate passes. Emits a `patch` entry for every published `@aws-blocks/*`
 * package whose package.json changed vs the base ref (a dep bump is
 * non-breaking → patch), plus the umbrella `@aws-blocks/blocks` whenever a
 * sibling it re-exports is in the set (its packed content moves with them).
 * Writes nothing when only test-apps/templates/private tooling changed.
 *
 * Usage: node --experimental-strip-types scripts/generate-dependency-changeset.ts [base-ref] [trigger]
 *   trigger: a word describing how the run was triggered (e.g. 'scheduled' |
 *   'manual'); folded into the changeset prose. Defaults to 'automated'.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const UMBRELLA = "@aws-blocks/blocks";
const baseRef = process.argv[2] ?? "origin/main";
const trigger = process.argv[3] ?? "automated";

const pkgName = (dir: string): string | null => {
	try {
		const p = JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf-8"));
		return !p.private && typeof p.name === "string" && p.name.startsWith("@aws-blocks/") ? p.name : null;
	} catch {
		return null; // deleted or unreadable
	}
};

const mergeBase = execFileSync("git", ["merge-base", baseRef, "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
const changed = new Set(
	execFileSync("git", ["diff", "--name-only", mergeBase], { cwd: ROOT, encoding: "utf-8" })
		.split("\n")
		.map((f) => f.match(/^packages\/([^/]+)\/package\.json$/)?.[1])
		.filter((d): d is string => Boolean(d))
		.map(pkgName)
		.filter((n): n is string => Boolean(n)),
);

if (changed.size === 0) {
	console.log("No published packages changed; no changeset needed.");
	process.exit(0);
}

// The umbrella must bump alongside any sibling it re-exports (verify-umbrella).
const umbrellaDeps = JSON.parse(readFileSync(join(ROOT, "packages/blocks/package.json"), "utf-8")).dependencies ?? {};
if ([...changed].some((p) => p in umbrellaDeps && p !== UMBRELLA)) changed.add(UMBRELLA);

const date = new Date().toISOString().slice(0, 10);
const frontmatter = [...changed].sort().map((p) => `"${p}": patch`).join("\n");
const out = join(ROOT, ".changeset", `dependency-bump-${date}.md`);
writeFileSync(out, `---\n${frontmatter}\n---\n\nchore: ${trigger} dependency bump (${date})\n`);
console.log(`Wrote ${out} covering ${changed.size} package(s): ${[...changed].sort().join(", ")}`);
