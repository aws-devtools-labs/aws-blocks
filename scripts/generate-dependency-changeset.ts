// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Write a changeset for dependency bumps so they ship in the next release.
 * Emits a `patch` entry for every published `@aws-blocks/*` package with a
 * package.json changed vs the base ref (a dep bump is non-breaking → patch),
 * plus the umbrella `@aws-blocks/blocks` whenever a sibling it re-exports is
 * in the set (its packed content moves with them).
 *
 * Any package.json under packages/<x>/ counts as a change to package <x>, the
 * way changeset-guard.ts maps files to packages: a bump to a create-blocks-app
 * template (packages/create-blocks-app/templates/<t>/package.json) releases
 * @aws-blocks/create-blocks-app, which publishes its templates.
 *
 * Packages that a changeset on disk already covers are left out: they release
 * anyway, so a second entry would only add a changelog line. Writes nothing
 * when nothing is left (only test-apps/private tooling changed, or every
 * changed package is covered).
 *
 * Two callers:
 *   - Release (publish-packages.yml), with the last `chore: version packages`
 *     commit as base: covers Dependabot bumps, which merge without a changeset
 *     (see verify-coverage in changeset-guard.ts).
 *   - The weekly ncu job (dependency-update.yml), with the branch it bumps.
 *
 * Usage: node --experimental-strip-types scripts/generate-dependency-changeset.ts [base-ref] [trigger]
 *   trigger: a word describing how the run was triggered (e.g. 'scheduled' |
 *   'manual'); folded into the changeset prose. Defaults to 'automated'.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CHANGESET_DIR = join(ROOT, ".changeset");
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

/** `@aws-blocks/*` packages named in the frontmatter of the changesets on disk. */
const coveredPackages = (): Set<string> => {
	const covered = new Set<string>();
	for (const file of readdirSync(CHANGESET_DIR)) {
		if (!file.endsWith(".md") || file === "README.md") continue;
		const frontmatter = readFileSync(join(CHANGESET_DIR, file), "utf-8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
		for (const line of frontmatter.split("\n")) {
			const pkg = line.match(/['"]?(@aws-blocks\/[^'":\s]+)['"]?\s*:/)?.[1];
			if (pkg) covered.add(pkg);
		}
	}
	return covered;
};

const mergeBase = execFileSync("git", ["merge-base", baseRef, "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
const changed = new Set(
	execFileSync("git", ["diff", "--name-only", mergeBase], { cwd: ROOT, encoding: "utf-8" })
		.split("\n")
		.map((f) => f.match(/^packages\/([^/]+)\/(?:.+\/)?package\.json$/)?.[1])
		.filter((d): d is string => Boolean(d))
		.map(pkgName)
		.filter((n): n is string => Boolean(n)),
);

// The umbrella must bump alongside any sibling it re-exports (verify-umbrella).
const umbrellaDeps = JSON.parse(readFileSync(join(ROOT, "packages/blocks/package.json"), "utf-8")).dependencies ?? {};
if ([...changed].some((p) => p in umbrellaDeps && p !== UMBRELLA)) changed.add(UMBRELLA);

const covered = coveredPackages();
const uncovered = [...changed].filter((p) => !covered.has(p)).sort();

if (uncovered.length === 0) {
	console.log(
		changed.size === 0
			? "No published packages changed; no changeset needed."
			: `All ${changed.size} changed package(s) are covered by changesets already; no changeset needed.`,
	);
	process.exit(0);
}

// Never overwrite a changeset on disk: same-day runs would drop its entries.
const date = new Date().toISOString().slice(0, 10);
let out = join(CHANGESET_DIR, `dependency-bump-${date}.md`);
for (let n = 2; existsSync(out); n++) out = join(CHANGESET_DIR, `dependency-bump-${date}-${n}.md`);

const frontmatter = uncovered.map((p) => `"${p}": patch`).join("\n");
writeFileSync(out, `---\n${frontmatter}\n---\n\nchore: ${trigger} dependency bump (${date})\n`);
console.log(`Wrote ${out} covering ${uncovered.length} package(s): ${uncovered.join(", ")}`);
