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
 *                   requires explicit sign-off, so CI hard-blocks it.
 *
 *   validate-structure  Exit non-zero if any changeset on disk is malformed:
 *                   broken frontmatter, an unparseable entry line, an invalid
 *                   bump type, or a package name that does not exist in the
 *                   workspace. The other guards' regex silently ignores lines
 *                   it can't parse, so a typo'd package or bad bump would slip
 *                   through and only fail post-merge at `changeset version`.
 *
 *   verify-umbrella Exit non-zero if this PR releases a package the umbrella
 *                   `@aws-blocks/blocks` re-exports without any pending
 *                   changeset bumping the umbrella too. Caret ranges keep the
 *                   sibling's new version in range, so `changeset version`
 *                   leaves the umbrella alone while its packed content still
 *                   moves, and publish then fails the whole release run.
 *                   Withdrawal counts as the same failure: removing an umbrella
 *                   entry an existing changeset already declared re-opens the
 *                   hole, so that case is checked against every pending sibling
 *                   release rather than only this PR's.
 *                   Only the entry's presence is checked, never its bump level.
 *                   A `patch` on the umbrella satisfies the guard even when a
 *                   sibling ships `minor` (a pre-1.0 break), because deciding
 *                   how breakage should propagate through re-exports is a
 *                   versioning-policy question, separate from the publish
 *                   failure this guard exists to prevent.
 *
 * Guards fail loudly. When one cannot read what it asserts against (a missing
 * or malformed package.json, say) it exits non-zero with the reason instead of
 * printing a green line it did not earn.
 *
 * Pre-1.0 semver convention:
 *   - `patch` (0.1.1 → 0.1.2): non-breaking change
 *   - `minor` (0.1.x → 0.2.0): BREAKING change (the pre-release breaking channel)
 *   - `major` (0.x   → 1.0.0): leaving pre-release / committing to a stable API
 *
 * Usage:
 *   node --experimental-strip-types scripts/changeset-guard.ts verify-coverage
 *   node --experimental-strip-types scripts/changeset-guard.ts block-major
 *   node --experimental-strip-types scripts/changeset-guard.ts validate-structure
 *   node --experimental-strip-types scripts/changeset-guard.ts verify-umbrella
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const CHANGESET_DIR = join(ROOT, ".changeset");
const SCOPE = "@aws-blocks/";
const UMBRELLA_PKG = "@aws-blocks/blocks";

// changesets/action opens its "Version Packages" PR with this title.
const RELEASE_PR_TITLE_PREFIX = "chore: version packages";

type BumpType = "major" | "minor" | "patch";

const VALID_BUMPS = new Set<BumpType>(["major", "minor", "patch"]);

interface Entry {
	file: string;
	pkg: string;
	type: BumpType;
}

/**
 * A guard could not evaluate what it was asked to assert. Reported as a normal
 * failure (exit 1) with the reason, never swallowed.
 */
class GuardError extends Error {}

/** Parse a JSON file, failing the guard loudly if it is unreadable or invalid. */
function readJson(path: string, label: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err) {
		throw new GuardError(`Cannot read ${label} (${path}): ${(err as Error).message}`);
	}
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new GuardError(`Cannot parse ${label} (${path}) as JSON: ${(err as Error).message}`);
	}
}

/** The `@aws-blocks/*` bumps declared in one changeset's frontmatter. */
function parseEntries(file: string, content: string): Entry[] {
	const entries: Entry[] = [];
	const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) return entries;

	for (const line of frontmatterMatch[1].split("\n")) {
		const entryMatch = line.match(
			/['"]?(@aws-blocks\/[^'":\s]+)['"]?\s*:\s*['"]?(major|minor|patch)['"]?/,
		);
		if (entryMatch) {
			entries.push({ file, pkg: entryMatch[1], type: entryMatch[2] as BumpType });
		}
	}
	return entries;
}

function parseChangesets(): Entry[] {
	if (!existsSync(CHANGESET_DIR)) return [];

	const files = readdirSync(CHANGESET_DIR).filter(
		(f) => f.endsWith(".md") && f !== "README.md",
	);

	return files.flatMap((file) =>
		parseEntries(file, readFileSync(join(CHANGESET_DIR, file), "utf-8")),
	);
}

/** Package names (@aws-blocks/*) covered by any changeset entry. */
function getCoveredPackages(): Set<string> {
	return new Set(parseChangesets().map((e) => e.pkg));
}

/** Where this branch left origin/main. Memoised: several guards ask for it. */
let mergeBaseCache: string | undefined;
function getMergeBase(): string {
	if (mergeBaseCache === undefined) {
		mergeBaseCache = execFileSync("git", ["merge-base", "origin/main", "HEAD"], {
			cwd: ROOT,
			encoding: "utf-8",
		}).trim();
	}
	return mergeBaseCache;
}

/** Files changed vs origin/main, as repo-relative paths. Includes deletions. */
let changedFilesCache: string[] | undefined;
function getChangedFiles(): string[] {
	if (changedFilesCache === undefined) {
		changedFilesCache = execFileSync("git", ["diff", "--name-only", getMergeBase()], {
			cwd: ROOT,
			encoding: "utf-8",
		})
			.trim()
			.split("\n")
			.filter(Boolean);
	}
	return changedFilesCache;
}

/** Publishable @aws-blocks/* packages with file changes vs origin/main. */
function getChangedPackages(): Set<string> {
	const packages = new Set<string>();
	for (const file of getChangedFiles()) {
		const match = file.match(/^packages\/([^/]+)\//);
		if (!match) continue;

		const pkgJsonPath = join(PACKAGES_DIR, match[1], "package.json");
		if (!existsSync(pkgJsonPath)) continue;

		const pkgJson = readJson(pkgJsonPath, `packages/${match[1]}/package.json`);
		if (typeof pkgJson.name === "string" && pkgJson.name.startsWith(SCOPE)) {
			packages.add(pkgJson.name);
		}
	}
	return packages;
}

function verifyCoverage(): number {
	// The "Version Packages" PR from changesets/action has bumped package.json
	// files but no .changeset/*.md left on disk (`changeset version` consumed
	// them). Coverage would see changed packages with no changesets and fail,
	// blocking the release PR. Skip the check for it.
	const prTitle = process.env.PR_TITLE ?? "";
	if (prTitle.startsWith(RELEASE_PR_TITLE_PREFIX)) {
		console.log(`✓ Skipping coverage check for the release PR ("${prTitle}").`);
		return 0;
	}

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

/**
 * The `@aws-blocks/*` packages the umbrella re-exports, read from its own
 * dependencies. Releasing any of them can change what the umbrella's tarball
 * ships without touching a single file the umbrella owns, which is why a file
 * diff can't be the signal here.
 *
 * An unreadable, malformed or sibling-less package.json fails the guard. With an
 * empty sibling set every PR would sail through the check while printing the
 * green line, so the one thing this must not do is carry on quietly.
 */
function getUmbrellaSiblings(): Set<string> {
	const pkgJsonPath = join(PACKAGES_DIR, "blocks", "package.json");
	const deps = readJson(pkgJsonPath, `${UMBRELLA_PKG}'s package.json`).dependencies;

	if (deps === null || typeof deps !== "object") {
		throw new GuardError(
			`${UMBRELLA_PKG}'s package.json (${pkgJsonPath}) has no "dependencies" object, so\n` +
			`the set of re-exported siblings cannot be determined.`,
		);
	}

	const siblings = new Set(
		Object.keys(deps as Record<string, unknown>).filter(
			(name) => name.startsWith(SCOPE) && name !== UMBRELLA_PKG,
		),
	);

	if (siblings.size === 0) {
		throw new GuardError(
			`${UMBRELLA_PKG}'s package.json (${pkgJsonPath}) declares no ${SCOPE}* dependencies.\n` +
			`The umbrella exists to re-export its siblings, so either that file was edited by\n` +
			`mistake or the umbrella has moved and this guard needs updating. Passing every PR\n` +
			`on an empty sibling set would be worse than failing here.`,
		);
	}
	return siblings;
}

/** Changeset filenames added, modified or deleted by this PR (vs origin/main). */
function getChangedChangesetFiles(): Set<string> {
	const names = new Set<string>();
	for (const file of getChangedFiles()) {
		const match = file.match(/^\.changeset\/([^/]+\.md)$/);
		if (match && match[1] !== "README.md") names.add(match[1]);
	}
	return names;
}

/** A changeset's entries as of the merge base; empty if this PR added the file. */
function parseChangesetAtMergeBase(file: string): Entry[] {
	let content: string;
	try {
		content = execFileSync("git", ["show", `${getMergeBase()}:.changeset/${file}`], {
			cwd: ROOT,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return []; // absent at the merge base
	}
	return parseEntries(file, content);
}

/**
 * Changesets this PR takes the umbrella entry away from: they declared
 * `@aws-blocks/blocks` at the merge base and no longer do, whether the line was
 * deleted or the whole file was. Coverage can be withdrawn as easily as it can
 * be forgotten, and the release aborts either way.
 */
function getWithdrawnUmbrellaFiles(pending: Entry[]): string[] {
	const stillDeclaring = new Set(
		pending.filter((e) => e.pkg === UMBRELLA_PKG).map((e) => e.file),
	);
	return [...getChangedChangesetFiles()]
		.filter(
			(file) =>
				!stillDeclaring.has(file) &&
				parseChangesetAtMergeBase(file).some((e) => e.pkg === UMBRELLA_PKG),
		)
		.sort();
}

/** Why an unbumped umbrella takes the whole release run down with it. */
const UMBRELLA_PUBLISH_FAILURE =
	`${UMBRELLA_PKG} pins its siblings with caret ranges, so their new versions stay in\n` +
	`range and \`changeset version\` leaves the umbrella at its current version. Its packed\n` +
	`content still moves (the re-exported APIs, plus docs/ assembled from sibling READMEs at\n` +
	`pack time), and publish then aborts the whole release run with "${UMBRELLA_PKG}@<version>\n` +
	`already exists with different content" (issue #273, previously #212).\n\n`;

function verifyUmbrella(): number {
	const siblings = getUmbrellaSiblings();
	const pending = parseChangesets();
	const touched = getChangedChangesetFiles();
	const withdrawnFrom = getWithdrawnUmbrellaFiles(pending);

	const siblingReleases = (entries: Entry[]) =>
		[...new Set(entries.filter((e) => siblings.has(e.pkg)).map((e) => e.pkg))].sort();

	// Normally only this PR's own changesets trigger the check: reading every
	// pending changeset would fail unrelated PRs for an omission someone else
	// merged. Withdrawal is the exception. This PR is what removed the coverage,
	// so every pending sibling release becomes its problem, including ones it
	// never touched. A revert that drops the sibling entries along with the
	// umbrella one leaves nothing pending and still passes.
	const released =
		withdrawnFrom.length > 0
			? siblingReleases(pending)
			: siblingReleases(pending.filter((e) => touched.has(e.file)));

	if (released.length === 0) {
		console.log(`✓ No changeset here releases a package ${UMBRELLA_PKG} re-exports.`);
		return 0;
	}

	// Coverage from any pending changeset counts: what matters is whether the
	// next release republishes the umbrella, not which PR asked for it.
	if (pending.some((e) => e.pkg === UMBRELLA_PKG)) {
		console.log(
			`✓ ${released.length} re-exported package(s) released, and ${UMBRELLA_PKG} is bumped alongside them.`,
		);
		return 0;
	}

	if (withdrawnFrom.length > 0) {
		console.error(`\n❌ This PR removes the ${UMBRELLA_PKG} entry from:\n`);
		for (const file of withdrawnFrom) {
			console.error(`   • .changeset/${file}`);
		}
		console.error("\nwhile these re-exported package(s) are still pending release:\n");
		for (const pkg of released) {
			console.error(`   • ${pkg}`);
		}
		console.error(
			`\nNothing bumps ${UMBRELLA_PKG} any more. ${UMBRELLA_PUBLISH_FAILURE}` +
			`Keep the entry, or move it to another pending changeset:\n\n` +
			`   "${UMBRELLA_PKG}": patch\n`,
		);
		return 1;
	}

	console.error(`\n❌ This PR releases package(s) that ${UMBRELLA_PKG} re-exports:\n`);
	for (const pkg of released) {
		console.error(`   • ${pkg}`);
	}
	console.error(
		`\nNothing bumps ${UMBRELLA_PKG}. ${UMBRELLA_PUBLISH_FAILURE}` +
		`Add this line to your changeset:\n\n` +
		`   "${UMBRELLA_PKG}": patch\n`,
	);
	return 1;
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
		"\nA `major` bump graduates the package to 1.0.0 (i.e. out of pre-release).\n" +
		"While pre-release, breaking changes ship as `minor` (0.x → 0.(x+1).0) and\n" +
		"non-breaking changes as `patch`. Change these entries to `minor` or `patch`.\n" +
		"Actually leaving pre-release (1.0.0) needs explicit sign-off.\n",
	);
	return 1;
}

/** Every package name declared across the npm workspaces (the set a changeset
 *  may legitimately reference). Workspace entries here are explicit paths. */
function getWorkspacePackageNames(): Set<string> {
	const names = new Set<string>();
	const workspaces = readJson(join(ROOT, "package.json"), "the root package.json").workspaces;
	if (!Array.isArray(workspaces)) {
		throw new GuardError(
			'The root package.json has no "workspaces" array, so changeset package names cannot\n' +
			"be validated against the workspace.",
		);
	}

	for (const ws of workspaces) {
		if (typeof ws !== "string" || ws.includes("*")) continue;
		const pkgJsonPath = join(ROOT, ws, "package.json");
		if (!existsSync(pkgJsonPath)) continue;
		const pkg = readJson(pkgJsonPath, `${ws}/package.json`);
		if (typeof pkg.name === "string") names.add(pkg.name);
	}
	return names;
}

function validateStructure(): number {
	if (!existsSync(CHANGESET_DIR)) {
		console.log("✓ No .changeset directory; nothing to validate.");
		return 0;
	}

	const files = readdirSync(CHANGESET_DIR).filter(
		(f) => f.endsWith(".md") && f !== "README.md",
	);
	if (files.length === 0) {
		console.log("✓ No changesets to validate.");
		return 0;
	}

	const validNames = getWorkspacePackageNames();
	const errors: string[] = [];

	for (const file of files) {
		const content = readFileSync(join(CHANGESET_DIR, file), "utf-8");
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (!frontmatterMatch) {
			errors.push(`${file}: missing or malformed frontmatter (expected a leading '---' … '---' block).`);
			continue;
		}

		for (const raw of frontmatterMatch[1].split("\n")) {
			const line = raw.trim();
			if (line === "") continue; // blank lines / empty (--empty) changesets are fine

			const entryMatch = line.match(/^['"]?([^'":]+?)['"]?\s*:\s*['"]?([^'"\s]+)['"]?$/);
			if (!entryMatch) {
				errors.push(`${file}: cannot parse entry line: "${line}"`);
				continue;
			}

			const pkg = entryMatch[1].trim();
			const bump = entryMatch[2].trim();
			if (!VALID_BUMPS.has(bump as BumpType)) {
				errors.push(`${file}: invalid bump "${bump}" for ${pkg} (expected major, minor, or patch).`);
			}
			if (!validNames.has(pkg)) {
				errors.push(`${file}: unknown package "${pkg}" (not found in the workspace).`);
			}
		}
	}

	if (errors.length > 0) {
		console.error("\n❌ Changeset structural validation failed:\n");
		for (const e of errors) {
			console.error(`   • ${e}`);
		}
		console.error(
			"\nThese slip past the regex guards but would fail post-merge at `changeset version`.\n" +
			'Each frontmatter line must read `"<package>": <major|minor|patch>` with a package\n' +
			"name that exists in the workspace.\n",
		);
		return 1;
	}

	console.log(`✓ ${files.length} changeset(s) are structurally valid.`);
	return 0;
}

function main(): number {
	const command = process.argv[2];

	switch (command) {
		case "verify-coverage":
			return verifyCoverage();
		case "block-major":
			return blockMajor();
		case "validate-structure":
			return validateStructure();
		case "verify-umbrella":
			return verifyUmbrella();
		default:
			console.error(
				`Unknown command: ${command ?? "(none)"}\n` +
				"Usage: node --experimental-strip-types scripts/changeset-guard.ts " +
				"<verify-coverage|block-major|validate-structure|verify-umbrella>",
			);
			return 2;
	}
}

try {
	process.exit(main());
} catch (err) {
	if (!(err instanceof GuardError)) throw err;
	console.error(`\n❌ ${err.message}\n`);
	process.exit(1);
}
