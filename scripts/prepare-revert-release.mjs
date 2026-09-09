// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Prepare a "revert last release" changeset PR: restore packages/ source to the
 * previous release and write a patch changeset, so merging the PR publishes a
 * superseding patch. npm is immutable — this rolls forward, it does not un-publish.
 * Release boundaries are the `chore: version packages` commits the pipeline stamps.
 *
 * Env: REASON (required), FORCE ("true" to revert even if packages/ changed since
 * the last release), PR_BODY_FILE, GITHUB_OUTPUT.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCOPE = "@aws-blocks/";
const KEEP = new Set(["package.json", "CHANGELOG.md"]); // reverting these would undo the version bump
const FORCE = process.env.FORCE === "true";
const REASON = (process.env.REASON ?? "").trim();
const PR_BODY_FILE = process.env.PR_BODY_FILE ?? resolve(ROOT, "revert-pr-body.md");

const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" }).trim();
const existsIn = (commit, file) => {
	try {
		execFileSync("git", ["cat-file", "-e", `${commit}:${file}`], { cwd: ROOT, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};
const fail = (msg, code = 1) => {
	console.error(`✗ ${msg}`);
	process.exit(code);
};

if (!REASON) fail("REASON is required.", 2);

const versions = git(["log", "--grep=^chore: version packages", "--format=%H"]).split("\n").filter(Boolean);
if (versions.length < 2) fail("Need two `chore: version packages` commits to revert the last release.", 3);
const [V1, V0] = versions;

if (git(["diff", "--name-only", V1, "HEAD", "--", "packages"]) && !FORCE) {
	fail("packages/ changed since the last release; that unreleased work would be reverted too. Re-run with FORCE=true.", 4);
}

const edits = [];
const dirs = new Set();
for (const file of git(["diff", "--name-only", V0, "HEAD", "--", "packages"]).split("\n").filter(Boolean)) {
	const m = file.match(/^packages\/([^/]+)\/(.+)$/);
	if (!m || KEEP.has(m[2].split("/").pop())) continue;
	dirs.add(m[1]);
	edits.push({ file, existsInV0: existsIn(V0, file) });
}

const packages = [];
for (const dir of [...dirs].sort()) {
	try {
		const { name } = JSON.parse(git(["show", `HEAD:packages/${dir}/package.json`]));
		if (typeof name === "string" && name.startsWith(SCOPE)) packages.push(name);
	} catch {
		// no package.json at HEAD (package added in the reverted release) — skip
	}
}

const last = git(["rev-parse", "--short", V1]);
const prev = git(["rev-parse", "--short", V0]);
const emit = (hasChanges) =>
	process.env.GITHUB_OUTPUT &&
	appendFileSync(process.env.GITHUB_OUTPUT, `has-changes=${hasChanges}\nlast-release=${last}\n`);

if (!edits.length || !packages.length) {
	console.log(`Nothing to revert: last release ${last} changed no publishable source.`);
	emit(false);
	process.exit(0);
}

for (const { file, existsInV0 } of edits) {
	if (existsInV0) git(["checkout", V0, "--", file]);
	else git(["rm", "--quiet", "--", file]);
}

const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
writeFileSync(
	resolve(ROOT, ".changeset", `revert-${stamp}.md`),
	`---\n${packages.map((p) => `"${p}": patch`).join("\n")}\n---\n\n${REASON}\n`,
);

writeFileSync(
	PR_BODY_FILE,
	`${[
		`Reverts the last release (\`${last}\`) source back to \`${prev}\`.`,
		"",
		`**Reason:** ${REASON}`,
		"",
		"**Reverted packages:**",
		...packages.map((p) => `- \`${p}\``),
		"",
		"Publishes as a superseding patch; npm can't un-publish (consider `npm deprecate`).",
	].join("\n")}\n`,
);

console.log(`Reverted ${edits.length} file(s) across ${packages.length} package(s); wrote changeset + PR body.`);
emit(true);
