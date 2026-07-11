// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Changeset guards used in CI. All subcommands share one changeset frontmatter
 * parser; their logic is otherwise independent:
 *
 *   verify-coverage Exit non-zero if any publishable package with file changes
 *                   (vs origin/main) has no changeset entry. Prevents the root
 *                   cause of EINTEGRITY errors: a package changes but its version
 *                   isn't bumped because the changeset forgot to mention it.
 *
 *   block-major     Exit non-zero if any changeset declares a `major` bump.
 *                   A `major` (0.x → 1.0.0) means leaving pre-release, which
 *                   requires explicit sign-off — so we hard-block it in CI.
 *
 * Pre-1.0 semver convention:
 *   - `patch` (0.1.1 → 0.1.2): non-breaking change
 *   - `minor` (0.1.x → 0.2.0): BREAKING change — the pre-release breaking channel
 *   - `major` (0.x   → 1.0.0): leaving pre-release / committing to a stable API
 *
 * Usage:
 *   tsx scripts/changeset-guard.ts verify-coverage
 *   tsx scripts/changeset-guard.ts block-major
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const CHANGESET_DIR = join(ROOT, ".changeset");
const SCOPE = "@aws-blocks/";

type BumpType = "major" | "minor" | "patch";

interface Entry {
	file: string;
	pkg: string;
	type: BumpType;
}

function parseChangesets(): Entry[] {
	const entries: Entry[] = [];
	if (!existsSync(CHANGESET_DIR)) return entries;

	const files = readdirSync(CHANGESET_DIR).filter(
		(f) => f.endsWith(".md") && f !== "README.md",
	);

	for (const file of files) {
		const content = readFileSync(join(CHANGESET_DIR, file), "utf-8");
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (!frontmatterMatch) continue;

		for (const line of frontmatterMatch[1].split("\n")) {
			const entryMatch = line.match(
				/['"]?(@aws-blocks\/[^'":\s]+)['"]?\s*:\s*['"]?(major|minor|patch)['"]?/,
			);
			if (entryMatch) {
				entries.push({ file, pkg: entryMatch[1], type: entryMatch[2] as BumpType });
			}
		}
	}
	return entries;
}

/** Package names (@aws-blocks/*) covered by any changeset entry. */
function getCoveredPackages(): Set<string> {
	return new Set(parseChangesets().map((e) => e.pkg));
}

/** Publishable @aws-blocks/* packages with file changes vs origin/main. */
function getChangedPackages(): Set<string> {
	const mergeBase = execSync("git merge-base origin/main HEAD", {
		cwd: ROOT,
		encoding: "utf-8",
	}).trim();
	const changedFiles = execSync(`git diff --name-only ${mergeBase}`, {
		cwd: ROOT,
		encoding: "utf-8",
	})
		.trim()
		.split("\n")
		.filter(Boolean);

	const packages = new Set<string>();
	for (const file of changedFiles) {
		const match = file.match(/^packages\/([^/]+)\//);
		if (!match) continue;

		const pkgJsonPath = join(PACKAGES_DIR, match[1], "package.json");
		if (!existsSync(pkgJsonPath)) continue;

		try {
			const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
			if (typeof pkgJson.name === "string" && pkgJson.name.startsWith(SCOPE)) {
				packages.add(pkgJson.name);
			}
		} catch {
			// skip unreadable package.json
		}
	}
	return packages;
}

function verifyCoverage(): number {
	const changedPackages = getChangedPackages();
	const coveredPackages = getCoveredPackages();
	const missing = [...changedPackages].filter((pkg) => !coveredPackages.has(pkg));

	if (missing.length > 0) {
		console.error("\n❌ The following packages have file changes but no changeset entry:\n");
		for (const pkg of missing.sort()) {
			console.error(`   • ${pkg}`);
		}
		console.error(
			"\nAdd a changeset covering these packages: npx changeset\n" +
			"An empty changeset (--empty) does NOT satisfy this check.\n",
		);
		return 1;
	}

	if (changedPackages.size > 0) {
		console.log(`✓ All ${changedPackages.size} changed package(s) are covered by changesets.`);
	} else {
		console.log("✓ No publishable packages were changed.");
	}
	return 0;
}

function blockMajor(): number {
	const majors = parseChangesets().filter((e) => e.type === "major");

	if (majors.length === 0) {
		console.log("✓ No major version bumps declared in changesets.");
		return 0;
	}

	console.error("\n❌ Major version bumps are not allowed while Blocks is pre-release.\n");
	console.error("The following changeset(s) declare a `major` release:\n");
	for (const { file, pkg } of majors) {
		console.error(`   • ${pkg}  (.changeset/${file})`);
	}
	console.error(
		"\nA `major` bump graduates the package to 1.0.0 — i.e. out of pre-release.\n" +
		"While pre-release, breaking changes ship as `minor` (0.x → 0.(x+1).0) and\n" +
		"non-breaking changes as `patch`. Change these entries to `minor` or `patch`.\n" +
		"Actually leaving pre-release (1.0.0) needs explicit sign-off.\n",
	);
	return 1;
}

const command = process.argv[2];

switch (command) {
	case "verify-coverage":
		process.exit(verifyCoverage());
		break;
	case "block-major":
		process.exit(blockMajor());
		break;
	default:
		console.error(
			`Unknown command: ${command ?? "(none)"}\n` +
			"Usage: tsx scripts/changeset-guard.ts <verify-coverage|block-major>",
		);
		process.exit(2);
}
