// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate a changeset for the weekly dependency bump.
 *
 * The weekly dependency-update workflow bumps dependency versions across the
 * monorepo. When that touches a *published* `@aws-blocks/*` package's
 * package.json, the `Require changeset` CI gate (scripts/changeset-guard.ts
 * verify-coverage) demands a changeset entry for it — otherwise the package's
 * files change but `changeset version` never bumps it, and publish later fails
 * with EINTEGRITY. The weekly PR had no changeset, so it failed that gate.
 *
 * This writes `.changeset/dependency-bump-<date>.md` with a `patch` entry for
 * every published package whose package.json changed vs the base ref, matching
 * the guard's own detection (packages/<x> whose name starts with @aws-blocks/).
 * A dependency bump is non-breaking, so `patch` is correct (never `minor`/
 * `major`). If any changed package is one the umbrella `@aws-blocks/blocks`
 * re-exports, the umbrella is bumped too (verify-umbrella), since its packed
 * content moves with its siblings.
 *
 * No changed published packages → no changeset is written (the guard passes on
 * its own: "No publishable packages were changed"). This happens when a weekly
 * run only touches test-apps/templates/private tooling.
 *
 * Usage: node --experimental-strip-types scripts/generate-dependency-changeset.ts <base-ref>
 *   base-ref defaults to origin/main; the workflow passes the PR base branch.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const CHANGESET_DIR = join(ROOT, ".changeset");
const SCOPE = "@aws-blocks/";
const UMBRELLA_PKG = "@aws-blocks/blocks";

const baseRef = process.argv[2] ?? "origin/main";

/** package.json files changed vs the base ref, as repo-relative paths. */
function changedPackageJsonFiles(): string[] {
	const mergeBase = execFileSync("git", ["merge-base", baseRef, "HEAD"], {
		cwd: ROOT,
		encoding: "utf-8",
	}).trim();
	return execFileSync("git", ["diff", "--name-only", mergeBase], {
		cwd: ROOT,
		encoding: "utf-8",
	})
		.trim()
		.split("\n")
		.filter((f) => /^packages\/[^/]+\/package\.json$/.test(f));
}

/** Published @aws-blocks/* package names whose package.json changed. */
function changedPublishedPackages(): Set<string> {
	const names = new Set<string>();
	for (const file of changedPackageJsonFiles()) {
		const dir = file.replace(/\/package\.json$/, "");
		const pkgJsonPath = join(ROOT, dir, "package.json");
		if (!existsSync(pkgJsonPath)) continue; // deleted package
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { name?: string; private?: boolean };
		// Skip private packages: they are never published, so a changeset entry
		// for them would fail validate-structure's workspace-name check only if
		// absent from workspaces, but more importantly they don't need a release.
		if (pkg.private === true) continue;
		if (typeof pkg.name === "string" && pkg.name.startsWith(SCOPE)) names.add(pkg.name);
	}
	return names;
}

/** The @aws-blocks/* packages the umbrella re-exports (its own dependencies). */
function umbrellaSiblings(): Set<string> {
	const pkgJson = JSON.parse(readFileSync(join(PACKAGES_DIR, "blocks", "package.json"), "utf-8")) as {
		dependencies?: Record<string, string>;
	};
	return new Set(
		Object.keys(pkgJson.dependencies ?? {}).filter((n) => n.startsWith(SCOPE) && n !== UMBRELLA_PKG),
	);
}

function main(): void {
	const changed = changedPublishedPackages();

	if (changed.size === 0) {
		console.log("No published packages changed; no changeset needed.");
		return;
	}

	// If any changed package is an umbrella sibling, the umbrella must be bumped
	// alongside it (verify-umbrella), or the release aborts.
	const siblings = umbrellaSiblings();
	if ([...changed].some((pkg) => siblings.has(pkg))) {
		changed.add(UMBRELLA_PKG);
	}

	const date = new Date().toISOString().slice(0, 10);
	// A dependency bump is non-breaking → patch (never minor/major, which
	// block-major would also reject for major).
	const frontmatter = [...changed].sort().map((pkg) => `"${pkg}": patch`).join("\n");
	const body = `chore: weekly dependency bump (${date})

Routine dependency version bumps across the monorepo via \`npm-check-updates\`.
No API changes.`;
	const content = `---\n${frontmatter}\n---\n\n${body}\n`;

	const outPath = join(CHANGESET_DIR, `dependency-bump-${date}.md`);
	writeFileSync(outPath, content);
	console.log(`Wrote ${outPath} covering ${changed.size} package(s):`);
	for (const pkg of [...changed].sort()) console.log(`  • ${pkg}`);
}

main();
