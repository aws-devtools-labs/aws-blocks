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
 *                   Skipped for the Version Packages PR, and for Dependabot PRs
 *                   that only change package.json/package-lock.json files: the
 *                   release job writes their changeset (see
 *                   generate-dependency-changeset.ts).
 *
 *   block-major     Exit non-zero if any changeset declares a `major` bump.
 *                   A `major` (0.x → 1.0.0) means leaving pre-release, which
 *                   requires explicit sign-off, so CI hard-blocks it.
 *
 *   validate-structure  Exit non-zero if any changeset on disk is malformed:
 *                   broken frontmatter, an unparseable entry line, an invalid
 *                   bump type, or a package name that does not exist in the
 *                   workspace (or, for a changeset under native/<x>/.changeset,
 *                   a name that is not that native package from
 *                   native/<x>/package.json). The other guards' regex silently
 *                   ignores lines it can't parse, so a typo'd package or bad
 *                   bump would slip through and only fail post-merge at
 *                   `changeset version`.
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
 *   verify-scaffolder Exit non-zero if this PR moves a package that
 *                   `@aws-blocks/create-blocks-app` stamps into new apps (each
 *                   `@aws-blocks/*` devDependency of the CLI) to a new release
 *                   line, a `minor` or `major` changeset, without any pending
 *                   changeset releasing create-blocks-app. The CLI stamps the
 *                   caret range from its own devDependencies, and a
 *                   devDependency bump never releases it (changesets assigns
 *                   bump type `none`), so the published CLI would keep
 *                   scaffolding apps on the previous line. A `patch` needs
 *                   nothing: the caret range already admits it. Withdrawing a
 *                   create-blocks-app entry is checked like verify-umbrella.
 *                   The release PR has no changesets left, so there the same
 *                   rule is read from the version diff instead: a stamped
 *                   package whose release line changes needs a
 *                   create-blocks-app version change alongside it.
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
 *   node --experimental-strip-types scripts/changeset-guard.ts verify-scaffolder
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const CHANGESET_DIR = join(ROOT, ".changeset");
const NATIVE_DIR = join(ROOT, "native");
const SCOPE = "@aws-blocks/";
const UMBRELLA_PKG = "@aws-blocks/blocks";
const SCAFFOLDER_PKG = "@aws-blocks/create-blocks-app";

// changesets/action opens its "Version Packages" PR with this title.
const RELEASE_PR_TITLE_PREFIX = "chore: version packages";

// Dependabot opens its PRs as this user; GitHub sets the login, so a PR can't claim it.
const DEPENDABOT_LOGIN = "dependabot[bot]";

/** The files a Dependabot npm update writes: manifests and the lockfile. */
const isManifestFile = (file: string): boolean => /(^|\/)package(-lock)?\.json$/.test(file);

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
		// Private packages are never published, so a changeset for them would describe a release that can't happen.
		if (pkgJson.private === true) continue;
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

	// Dependabot can't write a changeset, so its manifest-only bumps merge without
	// one and the release job adds it: publish-packages.yml runs
	// generate-dependency-changeset.ts against the last release before
	// `changeset version`. Any other file in the diff (a maintainer's fix pushed
	// onto the branch, say) brings back the normal check.
	const prAuthor = process.env.PR_AUTHOR ?? "";
	if (prAuthor === DEPENDABOT_LOGIN && getChangedFiles().every(isManifestFile)) {
		console.log("✓ Skipping coverage check for a Dependabot manifest bump; the release job writes its changeset.");
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

/** Changeset filenames that existed in .changeset/ at the merge base. */
let baseChangesetsCache: Set<string> | undefined;
function getChangesetsAtMergeBase(): Set<string> {
	if (baseChangesetsCache === undefined) {
		let listing: string;
		try {
			listing = execFileSync("git", ["ls-tree", "--name-only", `${getMergeBase()}:.changeset`], {
				cwd: ROOT,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			// No .changeset directory at the merge base, so nothing can have been
			// withdrawn. This is the only reason the listing can legitimately fail,
			// which is why it is asked for once here rather than per file below.
			listing = "";
		}
		baseChangesetsCache = new Set(listing.split("\n").filter(Boolean));
	}
	return baseChangesetsCache;
}

/** A changeset's entries as of the merge base. Only call it for files that existed there. */
function parseChangesetAtMergeBase(file: string): Entry[] {
	const content = execFileSync("git", ["show", `${getMergeBase()}:.changeset/${file}`], {
		cwd: ROOT,
		encoding: "utf-8",
	});
	return parseEntries(file, content);
}

/**
 * Changesets this PR takes the `pkg` entry away from (the umbrella, say): they
 * declared `pkg` at the merge base and no longer do, whether the line was
 * deleted or the whole file was. Coverage can be withdrawn as easily as it can
 * be forgotten, and the release aborts either way.
 */
function getWithdrawnFiles(pending: Entry[], pkg: string): string[] {
	const stillDeclaring = new Set(
		pending.filter((e) => e.pkg === pkg).map((e) => e.file),
	);
	const atMergeBase = getChangesetsAtMergeBase();
	return [...getChangedChangesetFiles()]
		.filter(
			(file) =>
				!stillDeclaring.has(file) &&
				atMergeBase.has(file) &&
				parseChangesetAtMergeBase(file).some((e) => e.pkg === pkg),
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
	const withdrawnFrom = getWithdrawnFiles(pending, UMBRELLA_PKG);

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

/**
 * The `@aws-blocks/*` packages create-blocks-app stamps into the apps it
 * scaffolds, read from its own devDependencies (the CLI reads the same list at
 * scaffold time, so the two cannot drift).
 *
 * An unreadable, malformed or empty list fails the guard: an empty set would
 * pass every PR while printing the green line.
 */
function getStampedPackages(): Set<string> {
	const pkgJsonPath = join(PACKAGES_DIR, "create-blocks-app", "package.json");
	const devDeps = readJson(pkgJsonPath, `${SCAFFOLDER_PKG}'s package.json`).devDependencies;

	const stamped = new Set(
		devDeps !== null && typeof devDeps === "object"
			? Object.keys(devDeps as Record<string, unknown>).filter(
					(name) => name.startsWith(SCOPE) && name !== SCAFFOLDER_PKG,
				)
			: [],
	);

	if (stamped.size === 0) {
		throw new GuardError(
			`${SCAFFOLDER_PKG}'s package.json (${pkgJsonPath}) declares no ${SCOPE}* devDependencies.\n` +
			`Those are the packages the CLI stamps into scaffolded apps, so either that file was\n` +
			`edited by mistake or the stamping moved and this guard needs updating. Passing every\n` +
			`PR on an empty set would be worse than failing here.`,
		);
	}
	return stamped;
}

/** A package's version from its package.json at the merge base, or null if it did not exist there. */
function getVersionAtMergeBase(dir: string): string | null {
	let raw: string;
	try {
		raw = execFileSync("git", ["show", `${getMergeBase()}:packages/${dir}/package.json`], {
			cwd: ROOT,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
	try {
		const { version } = JSON.parse(raw);
		return typeof version === "string" ? version : null;
	} catch (err) {
		throw new GuardError(`Cannot parse packages/${dir}/package.json at the merge base: ${(err as Error).message}`);
	}
}

/** A package's version from its package.json at HEAD. */
function getVersionAtHead(dir: string): string {
	const { version } = readJson(join(PACKAGES_DIR, dir, "package.json"), `packages/${dir}/package.json`);
	if (typeof version !== "string") {
		throw new GuardError(`packages/${dir}/package.json has no "version" string.`);
	}
	return version;
}

/** The pre-1.0 release line a version belongs to: `0.8.3` → `0.8`, `1.2.0` → `1`. */
function releaseLine(version: string): string {
	const [major, minor] = version.split(".");
	return major === "0" ? `0.${minor}` : (major ?? version);
}

/** Why a stamped package's new release line needs a create-blocks-app release too. */
const SCAFFOLDER_STALE_STAMP =
	`${SCAFFOLDER_PKG} stamps a caret range for each of these packages into every app it\n` +
	`scaffolds, read from its own devDependencies. \`changeset version\` moves that range,\n` +
	`but a devDependency bump never releases the CLI (changesets assigns it bump type\n` +
	`\`none\`), so the published CLI would keep scaffolding new apps on the previous release\n` +
	`line. Patches need nothing: the caret range already admits them.\n\n`;

function verifyScaffolder(): number {
	const stamped = getStampedPackages();

	// The release PR has consumed every changeset, so read the rule from the
	// version diff there. On any other PR no version moves and this is a no-op.
	const scaffolderMoved = getVersionAtMergeBase("create-blocks-app") !== getVersionAtHead("create-blocks-app");
	const lineChanges = [...stamped]
		.sort()
		.map((pkg) => {
			const dir = pkg.slice(SCOPE.length);
			return { pkg, from: getVersionAtMergeBase(dir), to: getVersionAtHead(dir) };
		})
		.filter(({ from, to }) => from !== null && releaseLine(from) !== releaseLine(to));

	if (lineChanges.length > 0 && !scaffolderMoved) {
		console.error(`\n❌ These package(s) move to a new release line, but ${SCAFFOLDER_PKG} keeps its version:\n`);
		for (const { pkg, from, to } of lineChanges) {
			console.error(`   • ${pkg}  ${from} → ${to}`);
		}
		console.error(
			`\n${SCAFFOLDER_STALE_STAMP}` +
			`A changeset moved them without a ${SCAFFOLDER_PKG} entry. Merge a changeset releasing\n` +
			`${SCAFFOLDER_PKG} to main, then let the release PR regenerate.\n`,
		);
		return 1;
	}

	const pending = parseChangesets();
	const touched = getChangedChangesetFiles();
	const withdrawnFrom = getWithdrawnFiles(pending, SCAFFOLDER_PKG);

	const lineMoves = (entries: Entry[]) =>
		[...new Set(entries.filter((e) => stamped.has(e.pkg) && e.type !== "patch").map((e) => e.pkg))].sort();

	// As in verifyUmbrella: only this PR's own changesets trigger the check,
	// unless this PR withdrew a create-blocks-app entry, which makes every
	// pending line move its problem.
	const moved =
		withdrawnFrom.length > 0
			? lineMoves(pending)
			: lineMoves(pending.filter((e) => touched.has(e.file)));

	if (moved.length === 0) {
		if (lineChanges.length > 0) {
			console.log(
				`✓ ${lineChanges.length} stamped package(s) move to a new release line, and ${SCAFFOLDER_PKG} is released alongside them.`,
			);
		} else {
			console.log(`✓ No changeset here moves a package ${SCAFFOLDER_PKG} stamps to a new release line.`);
		}
		return 0;
	}

	// Coverage from any pending changeset counts: what matters is whether the
	// next release republishes the CLI, not which PR asked for it.
	if (pending.some((e) => e.pkg === SCAFFOLDER_PKG)) {
		console.log(
			`✓ ${moved.length} stamped package(s) move to a new release line, and ${SCAFFOLDER_PKG} is released alongside them.`,
		);
		return 0;
	}

	if (withdrawnFrom.length > 0) {
		console.error(`\n❌ This PR removes the ${SCAFFOLDER_PKG} entry from:\n`);
		for (const file of withdrawnFrom) {
			console.error(`   • .changeset/${file}`);
		}
		console.error("\nwhile these stamped package(s) are still pending a new release line:\n");
		for (const pkg of moved) {
			console.error(`   • ${pkg}`);
		}
		console.error(
			`\nNothing releases ${SCAFFOLDER_PKG} any more. ${SCAFFOLDER_STALE_STAMP}` +
			`Keep the entry, or move it to another pending changeset:\n\n` +
			`   "${SCAFFOLDER_PKG}": patch\n`,
		);
		return 1;
	}

	console.error(`\n❌ This PR moves package(s) that ${SCAFFOLDER_PKG} stamps into new apps to a new release line:\n`);
	for (const pkg of moved) {
		console.error(`   • ${pkg}`);
	}
	console.error(
		`\nNothing releases ${SCAFFOLDER_PKG}. ${SCAFFOLDER_STALE_STAMP}` +
		`Add this line to your changeset:\n\n` +
		`   "${SCAFFOLDER_PKG}": patch\n`,
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

/**
 * Validate every changeset .md in one directory: frontmatter present, each
 * entry line parseable, bump in VALID_BUMPS, and package name in `validNames`.
 * Extracted so the same rules apply to the root .changeset dir and to each
 * native/<x>/.changeset dir (see validateStructure). `label` is the dir's
 * repo-relative name, used as the file-path prefix in error messages;
 * `scopeDesc` names where valid package names come from (e.g. "the workspace").
 * Regex/parsing is identical to the original inline root-dir loop.
 *
 * Returns both the `count` of .md files it actually iterated (README.md
 * excluded) and the `errors` it found, from ONE readdir. Deriving the count and
 * the errors from the same listing means a zero-count shortcut can never mask
 * an error a separately-filtered count missed.
 */
function validateChangesetDir(dir: string, validNames: Set<string>, label: string, scopeDesc: string): { count: number; errors: string[] } {
	const errors: string[] = [];
	if (!existsSync(dir)) return { count: 0, errors };

	const files = readdirSync(dir).filter(
		(f) => f.endsWith(".md") && f !== "README.md",
	);

	for (const file of files) {
		const content = readFileSync(join(dir, file), "utf-8");
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (!frontmatterMatch) {
			errors.push(`${label}/${file}: missing or malformed frontmatter (expected a leading '---' … '---' block).`);
			continue;
		}

		for (const raw of frontmatterMatch[1].split("\n")) {
			const line = raw.trim();
			if (line === "") continue; // blank lines / empty (--empty) changesets are fine

			const entryMatch = line.match(/^['"]?([^'":]+?)['"]?\s*:\s*['"]?([^'"\s]+)['"]?$/);
			if (!entryMatch) {
				errors.push(`${label}/${file}: cannot parse entry line: "${line}"`);
				continue;
			}

			const pkg = entryMatch[1].trim();
			const bump = entryMatch[2].trim();
			if (!VALID_BUMPS.has(bump as BumpType)) {
				errors.push(`${label}/${file}: invalid bump "${bump}" for ${pkg} (expected major, minor, or patch).`);
			}
			if (!validNames.has(pkg)) {
				errors.push(`${label}/${file}: unknown package "${pkg}" (not found in ${scopeDesc}).`);
			}
		}
	}
	return { count: files.length, errors };
}

/**
 * A native package validates its changesets against its own package name
 * (e.g. "aws-blocks-swift"), read from native/<x>/package.json — those names
 * are not JS workspace packages. A missing manifest yields an empty set, so
 * every entry flags as an unknown package below rather than passing silently;
 * a manifest that exists but is unreadable or invalid fails the guard loudly
 * (a GuardError), matching how the workspace manifests are read.
 */
function readNativePackageNames(nativeDir: string, label: string): Set<string> {
	const pkgJson = join(nativeDir, "package.json");
	const names = new Set<string>();
	if (existsSync(pkgJson)) {
		const { name } = readJson(pkgJson, `${label}/package.json`);
		if (typeof name === "string" && name) names.add(name);
	}
	return names;
}

function validateStructure(): number {
	const hasRoot = existsSync(CHANGESET_DIR);
	const hasNative = existsSync(NATIVE_DIR);

	if (!hasRoot && !hasNative) {
		console.log("✓ No .changeset directory; nothing to validate.");
		return 0;
	}

	const errors: string[] = [];
	let validated = 0;

	// Root changesets: validated against the JS workspace package names,
	// exactly as before.
	if (hasRoot) {
		const result = validateChangesetDir(CHANGESET_DIR, getWorkspacePackageNames(), ".changeset", "the workspace");
		validated += result.count;
		errors.push(...result.errors);
	}

	// Native changesets (native/<x>/.changeset) carry contributor-authored
	// prose/frontmatter for the native SDKs. Validating them here means a
	// malformed or wrong-package native changeset fails on the PR instead of
	// being trusted until it breaks the release. Each native tree validates
	// against its OWN package.json name, not the JS workspace.
	if (hasNative) {
		for (const entry of readdirSync(NATIVE_DIR)) {
			const dir = join(NATIVE_DIR, entry, ".changeset");
			if (!existsSync(dir)) continue;
			const result = validateChangesetDir(dir, readNativePackageNames(join(NATIVE_DIR, entry), `native/${entry}`), `native/${entry}/.changeset`, `native/${entry}`);
			validated += result.count;
			errors.push(...result.errors);
		}
	}

	// Check for errors BEFORE the zero-count shortcut. Counting and validation
	// now come from the same readdir per dir, but ordering the errors check
	// first guarantees a non-empty errors list can never be masked by a
	// (correct or not) zero count.
	if (errors.length > 0) {
		console.error("\n❌ Changeset structural validation failed:\n");
		for (const e of errors) {
			console.error(`   • ${e}`);
		}
		console.error(
			"\nThese slip past the regex guards but would fail post-merge at `changeset version`.\n" +
			'Each frontmatter line must read `"<package>": <major|minor|patch>` with a package\n' +
			"name that exists in the workspace. A changeset under native/<x>/.changeset must name\n" +
			"that native package (from native/<x>/package.json) instead.\n",
		);
		return 1;
	}

	if (validated === 0) {
		console.log("✓ No changesets to validate.");
		return 0;
	}

	console.log(`✓ ${validated} changeset(s) are structurally valid.`);
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
		case "verify-scaffolder":
			return verifyScaffolder();
		default:
			console.error(
				`Unknown command: ${command ?? "(none)"}\n` +
				"Usage: node --experimental-strip-types scripts/changeset-guard.ts " +
				"<verify-coverage|block-major|validate-structure|verify-umbrella|verify-scaffolder>",
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
