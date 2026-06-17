// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-release changeset guards. Two independent subcommands share the same
 * changeset parsing, but their logic is otherwise separate:
 *
 *   block-major     Exit non-zero if any changeset declares a `major` bump.
 *                   A `major` (0.x → 1.0.0) means leaving pre-release, which
 *                   requires explicit sign-off — so we hard-block it in CI.
 *
 *   report-breaking Surface (do NOT block) `minor` bumps. Pre-1.0, a `minor`
 *                   (0.x → 0.(x+1).0) is the semver signal for a breaking
 *                   change. Writes a Markdown body for a sticky PR comment.
 *
 * Pre-1.0 semver convention:
 *   - `patch` (0.1.1 → 0.1.2): non-breaking change
 *   - `minor` (0.1.x → 0.2.0): BREAKING change — the pre-release breaking channel
 *   - `major` (0.x   → 1.0.0): leaving pre-release / committing to a stable API
 *
 * Usage:
 *   tsx scripts/changeset-guard.ts block-major
 *   tsx scripts/changeset-guard.ts report-breaking
 *
 * report-breaking honors:
 *   - COMMENT_BODY_FILE: path to write the Markdown comment body
 *   - GITHUB_OUTPUT:     appends `has-breaking=true|false`
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CHANGESET_DIR = join(ROOT, ".changeset");
const MARKER = "<!-- changeset-breaking-changes -->";

type BumpType = "major" | "minor" | "patch";

interface Entry {
	file: string;
	pkg: string;
	type: BumpType;
}

// ── Shared parsing ──────────────────────────────────────────────────

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

// ── Subcommand: block-major ─────────────────────────────────────────

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

// ── Subcommand: report-breaking ─────────────────────────────────────

function breakingBody(pkgs: string[]): string {
	return [
		MARKER,
		"### ⚠️ Breaking change detected (pre-release)",
		"",
		"This PR includes a `minor` changeset. While Blocks is pre-`1.0.0`, a `minor`",
		"bump (`0.x` → `0.(x+1).0`) is the semver signal for a **breaking change**.",
		"",
		"Breaking changes are allowed pre-release — this is just a heads-up so reviewers",
		"and consumers are aware. Make sure the changeset summary explains the break and",
		"any migration steps.",
		"",
		"**Packages with a breaking (`minor`) bump:**",
		...pkgs.map((p) => `- \`${p}\``),
		"",
		"_Non-breaking changes should use `patch`. A `major` bump (→ `1.0.0`) is blocked_",
		"_separately until we deliberately leave pre-release._",
	].join("\n");
}

function resolvedBody(): string {
	return [
		MARKER,
		"### ✅ No breaking changes",
		"",
		"The current changesets contain no `minor` (breaking) bumps for `@aws-blocks/*`",
		"packages. Only non-breaking (`patch`) changes are queued.",
	].join("\n");
}

function reportBreaking(): number {
	const minors = parseChangesets().filter((e) => e.type === "minor");
	const hasBreaking = minors.length > 0;
	const pkgs = [...new Set(minors.map((m) => m.pkg))].sort();
	const body = hasBreaking ? breakingBody(pkgs) : resolvedBody();

	if (process.env.COMMENT_BODY_FILE) writeFileSync(process.env.COMMENT_BODY_FILE, body, "utf-8");
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `has-breaking=${hasBreaking}\n`);
	}

	if (hasBreaking) {
		console.log(`Found ${minors.length} breaking (minor) entr(ies):`);
		for (const { pkg, file } of minors) console.log(`   • ${pkg}  (.changeset/${file})`);
	} else {
		console.log("No breaking (minor) changesets found.");
	}
	return 0; // informational only — never fails the build
}

// ── CLI dispatch ────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
	case "block-major":
		process.exit(blockMajor());
		break;
	case "report-breaking":
		process.exit(reportBreaking());
		break;
	default:
		console.error(
			`Unknown command: ${command ?? "(none)"}\n` +
			"Usage: tsx scripts/changeset-guard.ts <block-major|report-breaking>",
		);
		process.exit(2);
}
