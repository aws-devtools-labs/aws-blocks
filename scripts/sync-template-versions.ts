// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keep the `@aws-blocks/*` dependency ranges in the create-blocks-app
 * templates on the releases that create-blocks-app ships with.
 *
 * A scaffolded app copies its template's package.json, so these ranges are
 * what every new app starts with. Each one is `^<version in this repo>`: a new
 * app gets the release that was current when create-blocks-app was published,
 * a reinstall takes the non-breaking updates that caret allows (on 0.x, patch
 * releases of the same minor), and never a release that can break it.
 *
 * Modes:
 *   --write      Set every range to `^<workspace version>`. Runs in
 *                `npm run version`, after `changeset version` has bumped the
 *                packages.
 *   --check      Exit 1 if any range differs from `^<workspace version>`.
 *   --changeset  Runs in `npm run version`, before `changeset version`. When a
 *                package the templates depend on is about to release a version
 *                outside its current template range, and create-blocks-app
 *                isn't releasing, write a patch changeset for create-blocks-app.
 *                Without it the new ranges would sit in the repo and never be
 *                published: a devDependency bump doesn't release the package
 *                that depends on it.
 *                Reads the bumps from the changeset files in .changeset/, like
 *                `changeset version` does, including an uncommitted one the
 *                release workflow writes. (`changeset status` would only count
 *                changesets added since a git ref, which on the release run is
 *                the commit being released, so it would report none.)
 *
 * Imports only Node built-ins, so Node type-strips and runs it directly:
 *   node --experimental-strip-types scripts/sync-template-versions.ts --write
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const TEMPLATES_DIR = join(PACKAGES_DIR, "create-blocks-app", "templates");
const CHANGESET_DIR = join(ROOT, ".changeset");
const CHANGESET_FILE = join(CHANGESET_DIR, "create-blocks-app-template-ranges.md");
const CREATE_APP = "@aws-blocks/create-blocks-app";
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"] as const;

type PackageJson = { name?: string; version?: string; private?: boolean } & Partial<Record<(typeof DEP_FIELDS)[number], Record<string, string>>>;
const BUMPS = ["patch", "minor", "major"] as const;
type Bump = (typeof BUMPS)[number];

const readJson = (path: string): PackageJson => JSON.parse(readFileSync(path, "utf-8"));

/** Every package.json under templates/, including nested ones such as amplify/aws-blocks/. */
function templatePackageJsons(dir = TEMPLATES_DIR): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...templatePackageJsons(path));
		else if (entry.name === "package.json") found.push(path);
	}
	return found.sort();
}

/** Name → version of each published `@aws-blocks/*` package in packages/. */
function workspaceVersions(): Map<string, string> {
	const versions = new Map<string, string>();
	for (const dir of readdirSync(PACKAGES_DIR)) {
		const path = join(PACKAGES_DIR, dir, "package.json");
		if (!existsSync(path)) continue;
		const pkg = readJson(path);
		if (!pkg.private && pkg.name?.startsWith("@aws-blocks/") && pkg.version) versions.set(pkg.name, pkg.version);
	}
	return versions;
}

/** Each `@aws-blocks/*` dependency the templates declare, with the file and current range. */
function templateDeps(): Array<{ file: string; field: (typeof DEP_FIELDS)[number]; name: string; range: string }> {
	const deps = [];
	for (const file of templatePackageJsons()) {
		const pkg = readJson(file);
		for (const field of DEP_FIELDS) {
			for (const [name, range] of Object.entries(pkg[field] ?? {})) {
				if (name.startsWith("@aws-blocks/")) deps.push({ file, field, name, range });
			}
		}
	}
	return deps;
}

/** The range a template should declare for a package at `version`. */
const expectedRange = (version: string): string => `^${version}`;

/**
 * Whether `version` satisfies caret range `range` (`^x.y.z`). Covers only the
 * ranges this script writes; anything else (e.g. a leftover `*`) counts as not
 * satisfied, so the template gets rewritten and create-blocks-app released.
 */
export function satisfiesCaret(version: string, range: string): boolean {
	const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
	const want = range.startsWith("^") ? parse(range.slice(1)) : undefined;
	const have = parse(version);
	if (!want || !have) return false;
	const [wMaj, wMin, wPat] = want;
	const [hMaj, hMin, hPat] = have;
	if (wMaj > 0) return hMaj === wMaj && (hMin > wMin || (hMin === wMin && hPat >= wPat));
	if (wMin > 0) return hMaj === 0 && hMin === wMin && hPat >= wPat;
	return hMaj === 0 && hMin === 0 && hPat === wPat;
}

function write(): void {
	const versions = workspaceVersions();
	// Edit the range in the file text rather than re-serializing, so the rest of
	// each file (escapes such as —, key order, spacing) stays byte-for-byte.
	const text = new Map<string, string>();
	for (const dep of templateDeps()) {
		const version = versions.get(dep.name);
		if (!version) throw new Error(`${relative(ROOT, dep.file)}: ${dep.name} is not a published package in packages/`);
		const want = expectedRange(version);
		if (dep.range === want) continue;
		const entry = new RegExp(`("${dep.name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"\\s*:\\s*)"[^"]*"`, "g");
		text.set(dep.file, (text.get(dep.file) ?? readFileSync(dep.file, "utf-8")).replace(entry, `$1"${want}"`));
		console.log(`${relative(ROOT, dep.file)}: ${dep.name} ${dep.range} -> ${want}`);
	}
	for (const [file, contents] of text) writeFileSync(file, contents);
}

function check(): void {
	const versions = workspaceVersions();
	const wrong = templateDeps().filter((dep) => dep.range !== expectedRange(versions.get(dep.name) ?? "<unpublished>"));
	if (wrong.length === 0) return;
	for (const dep of wrong) {
		const version = versions.get(dep.name);
		console.error(`${relative(ROOT, dep.file)}: ${dep.name} is "${dep.range}", expected "${version ? expectedRange(version) : `a published @aws-blocks package`}"`);
	}
	console.error("\nRun: node --experimental-strip-types scripts/sync-template-versions.ts --write");
	process.exit(1);
}

/** The highest bump each package gets from the changeset files on disk. */
function pendingBumps(): Map<string, Bump> {
	const bumps = new Map<string, Bump>();
	for (const file of readdirSync(CHANGESET_DIR)) {
		if (!file.endsWith(".md") || file === "README.md") continue;
		const frontmatter = readFileSync(join(CHANGESET_DIR, file), "utf-8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
		for (const line of frontmatter.split(/\r?\n/)) {
			const [, name, type] = line.match(/^\s*['"]?([^'":\s]+)['"]?\s*:\s*(patch|minor|major)\s*$/) ?? [];
			if (!name) continue;
			const bump = type as Bump;
			const current = bumps.get(name);
			if (!current || BUMPS.indexOf(bump) > BUMPS.indexOf(current)) bumps.set(name, bump);
		}
	}
	return bumps;
}

/** `version` after a `bump`, as `changeset version` computes it (no pre-release mode). */
export function bumpVersion(version: string, bump: Bump): string {
	const [major, minor, patch] = version.split(".").map(Number);
	if (bump === "major") return `${major + 1}.0.0`;
	if (bump === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

function changeset(): void {
	if (existsSync(join(CHANGESET_DIR, "pre.json"))) {
		console.log("Changesets is in pre-release mode; not writing a create-blocks-app changeset.");
		return;
	}
	const bumps = pendingBumps();
	if (bumps.has(CREATE_APP)) return;
	// A package that only releases as a dependent gets a patch bump, which stays
	// inside its caret range, so the packages named in a changeset are the ones
	// that can move a template range.
	const versions = workspaceVersions();
	const moved = new Map<string, string>();
	for (const dep of templateDeps()) {
		const bump = bumps.get(dep.name);
		const version = versions.get(dep.name);
		if (!bump || !version) continue;
		const next = bumpVersion(version, bump);
		if (!satisfiesCaret(next, dep.range)) moved.set(dep.name, next);
	}
	if (moved.size === 0) return;
	const list = [...moved].map(([name, version]) => `\`${name}@${version}\``).join(", ");
	writeFileSync(
		CHANGESET_FILE,
		`---\n"${CREATE_APP}": patch\n---\n\nNew apps depend on ${list}: the templates' \`@aws-blocks/*\` ranges move to the releases this version ships with.\n`,
	);
	console.log(`Wrote ${relative(ROOT, CHANGESET_FILE)} (${list})`);
}

const mode = process.argv[2];
if (mode === "--write") write();
else if (mode === "--check") check();
else if (mode === "--changeset") changeset();
else {
	console.error("Usage: node --experimental-strip-types scripts/sync-template-versions.ts --write | --check | --changeset");
	process.exit(2);
}
