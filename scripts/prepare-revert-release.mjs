// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Prepare a "revert last release" changeset PR.
 *
 * npm publishes are immutable, so this doesn't roll back — it restores the
 * source of the last release to the previous release's state and generates a
 * changeset, so merging the resulting PR publishes a superseding patch whose
 * code equals the previous release.
 *
 * Release boundaries are the `chore: version packages` commits the publish
 * pipeline stamps. "Last release" = the delta between the two most recent ones.
 *
 * Behaviour:
 *   - Reverts only changed *source* files under packages/ (skips package.json
 *     and CHANGELOG.md, so versions keep advancing and changelog history stays).
 *   - Writes a `patch` changeset covering the packages whose source changed.
 *   - Refuses to run if packages/ changed since the last release (that new work
 *     would be reverted too) unless FORCE=true.
 *
 * Env:
 *   REASON        summary for the changeset + PR body (required)
 *   FORCE         "true" to bypass the "main advanced" guard
 *   DRY_RUN       "true" to print the plan without touching the tree
 *   PR_BODY_FILE  where to write the PR body (default: ./revert-pr-body.md)
 *   GITHUB_OUTPUT appends has-changes / packages / boundaries when set
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCOPE = "@aws-blocks/";
const KEEP = new Set(["package.json", "CHANGELOG.md"]); // never reverted
const DRY_RUN = process.env.DRY_RUN === "true";
const FORCE = process.env.FORCE === "true";
const REASON = (process.env.REASON ?? "").trim();
const PR_BODY_FILE = process.env.PR_BODY_FILE ?? resolve(ROOT, "revert-pr-body.md");

function git(args) {
	return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" }).trim();
}
/** True if <file> exists in <commit>'s tree. Silent (no stderr leak). */
function fileExistsInCommit(commit, file) {
	try {
		execFileSync("git", ["cat-file", "-e", `${commit}:${file}`], {
			cwd: ROOT,
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}
function fail(msg, code = 1) {
	console.error(`✗ ${msg}`);
	process.exit(code);
}

if (!REASON) fail("REASON is required (why is the release being reverted?).", 2);

// 1. Release boundaries: the two most recent version commits.
const versionCommits = git([
	"log",
	"--grep=^chore: version packages",
	"--format=%H",
]).split("\n").filter(Boolean);
if (versionCommits.length < 2) {
	fail("Need at least two `chore: version packages` commits to revert the last release.", 3);
}
// V1 = last release, V0 = the one before. LAST_RELEASE/PREV_RELEASE override
// the auto-detected boundaries (for targeting a specific release or testing).
const V1 = process.env.LAST_RELEASE || versionCommits[0];
const V0 = process.env.PREV_RELEASE || versionCommits[1];

// 2. Guard: has packages/ changed since the last release (unreleased work)?
const advanced = git(["diff", "--name-only", V1, "HEAD", "--", "packages"])
	.split("\n").filter(Boolean);
if (advanced.length > 0 && !FORCE) {
	fail(
		`packages/ changed since the last release (${git(["rev-parse", "--short", V1])}). ` +
		"A tree-restore would revert that unreleased work too.\n" +
		"Re-run with FORCE=true to override, or do a selective revert by hand.",
		4,
	);
}

// 3. Source files that differ between the previous release and now.
const diff = git(["diff", "--name-only", V0, "HEAD", "--", "packages"])
	.split("\n").filter(Boolean);

/** @type {{file: string, existsInV0: boolean}[]} */
const sourceEdits = [];
const changedPkgDirs = new Set();
for (const file of diff) {
	const m = file.match(/^packages\/([^/]+)\/(.+)$/);
	if (!m) continue;
	const [, pkgDir, rel] = m;
	const base = rel.split("/").pop();
	if (KEEP.has(base)) continue; // leave versions + changelogs alone
	changedPkgDirs.add(pkgDir);
	// exists in V0 → restore its old content; absent → added after V0, remove it
	sourceEdits.push({ file, existsInV0: fileExistsInCommit(V0, file) });
}

// Map changed dirs → publishable @aws-blocks/* names.
const packages = [];
for (const dir of [...changedPkgDirs].sort()) {
	try {
		const pkg = JSON.parse(git(["show", `HEAD:packages/${dir}/package.json`]));
		if (typeof pkg.name === "string" && pkg.name.startsWith(SCOPE)) packages.push(pkg.name);
	} catch {
		// dir has no package.json at HEAD (e.g. package added in the reverted release) — skip
	}
}

const shortV0 = git(["rev-parse", "--short", V0]);
const shortV1 = git(["rev-parse", "--short", V1]);

function emitOutputs(hasChanges) {
	if (!process.env.GITHUB_OUTPUT) return;
	appendFileSync(process.env.GITHUB_OUTPUT,
		`has-changes=${hasChanges}\n` +
		`packages=${packages.join(",")}\n` +
		`prev-release=${shortV0}\n` +
		`last-release=${shortV1}\n`);
}

if (sourceEdits.length === 0 || packages.length === 0) {
	console.log(`✓ Nothing to revert: the last release (${shortV1}) changed no publishable source.`);
	emitOutputs(false);
	process.exit(0);
}

console.log(`Reverting last release ${shortV1} → source state of ${shortV0}`);
console.log(`Packages: ${packages.join(", ")}`);
console.log(`Source files: ${sourceEdits.length}`);

if (DRY_RUN) {
	for (const { file, existsInV0 } of sourceEdits) {
		console.log(`  ${existsInV0 ? "restore" : "remove "} ${file}`);
	}
	console.log("\n(DRY_RUN — no changes written)");
	emitOutputs(true);
	process.exit(0);
}

// 4. Apply: restore source to V0, remove files added since V0.
for (const { file, existsInV0 } of sourceEdits) {
	if (existsInV0) git(["checkout", V0, "--", file]);
	else git(["rm", "--quiet", "--", file]);
}

// 5. Write the changeset.
const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const changesetPath = resolve(ROOT, ".changeset", `revert-${stamp}.md`);
const frontmatter = packages.map((p) => `"${p}": patch`).join("\n");
writeFileSync(changesetPath, `---\n${frontmatter}\n---\n\n${REASON}\n`);
console.log(`✓ Wrote ${changesetPath}`);

// 6. PR body.
const body = [
	`Reverts the source changes from the last release (\`${shortV1}\`) back to the previous release (\`${shortV0}\`).`,
	"",
	`**Reason:** ${REASON}`,
	"",
	"**Packages reverted (will publish as a superseding patch):**",
	...packages.map((p) => `- \`${p}\``),
	"",
	"Version and changelog files were left untouched, so merging this bumps a new patch.",
	"npm can't un-publish; the bad version stays up (consider `npm deprecate`) and this patch supersedes it.",
].join("\n");
writeFileSync(PR_BODY_FILE, `${body}\n`);
console.log(`✓ Wrote PR body → ${PR_BODY_FILE}`);
emitOutputs(true);
