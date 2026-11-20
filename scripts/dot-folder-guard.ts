// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Checks tracked files for stale `.blocks` references and verifies that test-app data remains ignored.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OLD_FOLDER = ".blocks";
const NEW_FOLDER = ".cdk-blocks";
/** How much of a file decides whether it is binary. Git uses the same idea. */
const BINARY_SNIFF_BYTES = 8000;
/** The consolidated mock-data directory, relative to a project root. */
const MOCK_DATA_RELATIVE = ".cdk-blocks/local/data";

/**
 * Matches `.blocks` at path boundaries, excluding property reads, optional
 * chaining, spreads, suffixed names and the Dart output extension `.blocks.dart`.
 * Unicode classes exclude non-ASCII identifiers. A sentence-ending dot, a bare
 * trailing `?` and a Windows separator stay matches, because that is where a
 * stale reference survives a rename.
 */
const REFERENCE = /(?<![\p{L}\p{N}_)\]?.])(?<![)\]]\\)\.blocks(?![-\p{L}\p{N}_]|\??\.[\p{L}\p{N}_])/u;

/**
 * Paths that legitimately still name `.blocks`, each for a reason that does not
 * go away when the rename lands.
 *
 * `match` is explicit rather than inferred from the string, because inferring it
 * made every entry far wider than intended: a `prefix` entry naming a FILE also
 * exempted its siblings (`dot-folder-guard.ts` exempted `dot-folder-guard.ts.old`)
 * and a `suffix` entry matched any path merely ending in those characters
 * (`CHANGELOG.md` exempted `MY-CHANGELOG.md`). Use `dir` only for a directory,
 * and write the trailing slash so it cannot match a sibling file.
 */
const ALLOWED: ReadonlyArray<{
	readonly path: string;
	readonly match: "exact" | "dir" | "basename";
	/** Exempt only lines containing one of these snippets, rather than the whole file. */
	readonly only?: readonly string[];
	readonly why: string;
}> = [
	{
		path: 'packages/blocks/src/sandbox-url-decoupling.test.ts',
		match: 'exact',
		why: "Pins LEGACY_SANDBOX_DIR, the SIBLING `.blocks-sandbox` state directory, which keeps its pre-rename name. "
			+ 'It builds the name as a split literal so a rename pass cannot rewrite it, which also hides the `-sandbox` suffix from this guard.',
	},
	{
		path: '.changeset/pre/core-cdk-telemetry-opt-out.md',
		match: 'exact',
		why: "Main's changeset for removing the AWS Blocks telemetry opt-out; the old path names the mechanism it removed.",
	},
	{
		path: '.changeset/pre/remove-telemetry-task.md',
		match: 'exact',
		why: "Main's changeset for removing the telemetry task; the old path names the mechanism it removed.",
	},
	{
		path: "CHANGELOG.md",
		match: "basename",
		why: "published release history: each entry describes the folder under the name it had in that release",
	},
	{
		path: "docs/DECISIONS.md",
		only: ["`.blocks/data/`", "`.blocks/`", "holding what"],
		match: "exact",
		why: "a dated decision log: its \"Alternatives Considered\" lists and superseded clauses name the folder as it was called when that decision was taken, so D-001's rejected `.blocks/data/` has to stay readable as what was actually rejected. Its live guidance was renamed at this commit; a later stale reference here is history too",
	},
	{
		path: ".changeset/cdk-blocks-dot-folder.md",
		match: "exact",
		why: "the changeset announcing this rename, which has to name the old folder to say what to rename (`git mv .blocks .cdk-blocks`); at release its text moves into the changelogs above",
	},
	{
		path: ".changeset/pre/cdk-blocks-dot-folder.md",
		match: "exact",
		why: "the same changeset once `changeset version` has run: in pre mode a consumed changeset moves into `.changeset/pre/` and keeps its text",
	},
	{
		path: "packages/blocks/test-fixtures/migrate-apps.json",
		match: "exact",
		why: "snapshots of the scaffolded wrappers of past create-blocks-app releases, which `cdk-blocks migrate` recognises by the SHA-256 of their source: renaming the folder inside them makes migrate treat a real user's wrapper as an unrecognised version and keep it",
	},
	{
		path: "native/dart/packages/blocks_runtime/lib/src/file_token_store_io.dart",
		match: "exact",
		why: "the Dart client's own `~/.blocks/<applicationId>/dart/` session storage, the same case as the Kotlin entry below: a per-user directory, not the CLI's project or global config folder, so renaming it would sign every Dart app out for a rename it is not part of",
	},
	{
		path: "native/dart/packages/blocks_runtime/test/file_token_store_test.dart",
		match: "exact",
		why: "the tests of that storage directory, which assert on its real name",
	},
	{
		path: "native/dart/packages/blocks_runtime/README.md",
		match: "exact",
		why: "documents that storage directory's real name",
	},
	{
		path: "native/dart/README.md",
		match: "exact",
		why: "documents that storage directory's real name",
	},
	{
		path: "native/kotlin/runtime/src/jvmMain/",
		match: "dir",
		why: "the Kotlin client's own `~/.blocks/<applicationId>` desktop storage directory, which is a different directory from the CLI's project and global config folder and is not part of this rename",
	},
	{
		path: "native/kotlin/runtime/src/jvmTest/",
		match: "dir",
		why: "the tests of that storage directory, which assert on its real name",
	},
	{
		path: "native/kotlin/.changeset/",
		match: "dir",
		why: "the released notes describing that storage directory",
	},
	{
		path: "native/kotlin/README.md",
		match: "exact",
		why: "documents that storage directory's location",
	},
	{
		path: "native/kotlin/docs/runtime-configuration.md",
		match: "exact",
		why: "documents that storage directory and how to migrate off its older layout",
	},

	{
		path: "packages/core/src/scripts/stack-id.ts",
		only: ["LEGACY_BLOCKS_DIR", "`.blocks/config.json`"],
		match: "exact",
		why: "documents the pre-rename config it falls back to, which a reviewer asked for by name: the summary promising only the new path understated the compatibility behaviour",
	},
	{
		path: "packages/blocks/src/cli/commands/migrate.ts",
		match: "exact",
		only: ["'.blocks', 'config.json'", "still keeps its stackId", "git mv .blocks/config.json"],
		why: "names the pre-rename config so an app that still keeps its stackId there is told to move the file, rather than to invent a fresh id and create a second production stack",
	},
	{
		path: "packages/admin-ui/src/server/detect.ts",
		match: "exact",
		only: ["'.blocks', 'config.json'", "pre-rename file"],
		why: "reads the pre-rename config for a stackId, as core's getStackId does, so the dashboard does not report an upgraded but deployed app as not deployed",
	},
	{
		path: "packages/admin-ui/src/server/local-provider.ts",
		match: "exact",
		only: ["'.cdk-blocks', '.blocks'", "legacy stackId", "'.blocks', 'deploy-history.jsonl'", "pre-rename first"],
		why: "same pre-rename stackId read, so an upgraded app still shows its stack names",
	},
	{
		path: "packages/core/src/telemetry/identifiers.ts",
		match: "exact",
		only: ["LEGACY_BLOCKS_DIR", "`.blocks/config.json`", "`git mv .blocks .cdk-blocks`"],
		why: "reads the pre-rename config for an existing `telemetry.projectId`, so an upgraded app is not counted as a second project, and writes to whichever file the project already uses so the renamed one cannot shadow a legacy stackId",
	},
	{
		path: "packages/core/src/common/constants.ts",
		only: ["LEGACY_BLOCKS_DIR"],
		match: "exact",
		why: "declares LEGACY_BLOCKS_DIR, the pre-rename name getStackId reads because its absence fails silently rather than loudly",
	},
	{
		path: "packages/core/src/scripts/unrenamed-app.test.ts",
		match: "exact",
		why: "builds a project as it looks BEFORE the rename, which is the input its cases need: the two fallbacks it covers fail silently, so a test that asserted the constant rather than the on-disk layout would pass against a constant holding the new name",
	},
	{
		path: "packages/blocks/src/sandbox-dir-coverage.test.ts",
		match: "exact",
		why: "its LEGACY constant is the pre-rename sandbox directory, which the sandbox rename's own coverage test has to name in order to search for it",
	},
	{
		path: "scripts/dot-folder-guard.ts",
		match: "exact",
		why: "this guard names the old folder in order to search for it",
	},
	{
		path: "scripts/dot-folder-guard.test.mjs",
		match: "exact",
		why: "the guard's own tests build fixtures that name the old folder",
	},
];

/**
 * The guard could not evaluate what it was asked to assert. Reported as a normal
 * failure (exit 1) with the reason, never swallowed.
 */
class GuardError extends Error {}

/** Why `path` is allowed to name the old folder, or `undefined` if it is not. */
function allowedReason(path: string, line?: string): string | undefined {
	for (const entry of ALLOWED) {
		const hit =
			entry.match === "exact"
				? path === entry.path
				: entry.match === "dir"
					? path.startsWith(entry.path)
					: path === entry.path || path.endsWith(`/${entry.path}`);
		if (!hit) continue;
		// `only` narrows the exemption to the one reference the entry is about, so a
		// stale name elsewhere in the same file is still caught. These are the files
		// where a stale name does the most damage — the folder constants and the
		// stackId lookup — so exempting all of them wholesale is the wrong default.
		if (entry.only !== undefined && line !== undefined && !entry.only.some((p) => line.includes(p))) continue;
		return entry.why;
	}
	return undefined;
}

/**
 * Every file git tracks, relative to the repository root.
 *
 * An empty result means this is not the repository the guard assumes, which
 * would make the check pass vacuously — so that is a failure, not a green line.
 */
function trackedFiles(): string[] {
	let raw: string;
	try {
		raw = execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
	} catch (err) {
		throw new GuardError(`Cannot list the tracked files of ${ROOT}: ${(err as Error).message}`);
	}
	const files = raw.split("\0").filter((path) => path.length > 0);
	if (files.length === 0) {
		throw new GuardError(
			`git tracks no files in ${ROOT}. The guard asserts against that set, so an empty one means\n` +
				"it is not reading the repository it expects and the check would pass vacuously.",
		);
	}
	return files;
}

/**
 * Matches `.blocks` as a complete path segment, excluding `.blocks-sandbox`.
 * Separate from the content check because a stale filename need not contain the
 * old name anywhere in its text.
 */
const PATH_REFERENCE = /(^|\/)\.blocks(\/|$)/;

interface Reference {
	readonly path: string;
	/** `0` for a path reference, which is the file's location rather than a line in it. */
	readonly line: number;
	readonly text: string;
}

/**
 * Every tracked file that still names the old folder, in its path or on any of
 * its lines.
 *
 * A file that cannot be read fails the guard: an unreadable file is a file whose
 * references were not checked, which is not something to report as clean. A file
 * holding a NUL byte is binary and has no path text to read, but its own path is
 * still checked.
 */
function findReferences(): Reference[] {
	const found: Reference[] = [];
	for (const path of trackedFiles()) {
		// The PATH check runs before the allowlist and is never waived by it. Every
		// entry exists because a file's CONTENT has to name the old folder; none of
		// them is a reason to COMMIT a file at the old path, and short-circuiting
		// here let a directory entry disable both checks at once.
		if (PATH_REFERENCE.test(path)) {
			found.push({ path, line: 0, text: "this file is still at the old path" });
		}

		// A whole-file exemption short-circuits here; an entry with `only` is
		// decided per line below, so the rest of that file is still scanned.
		const fileWide = ALLOWED.find(
			(e) =>
				e.only === undefined &&
				(e.match === "exact"
					? path === e.path
					: e.match === "dir"
						? path.startsWith(e.path)
						: path === e.path || path.endsWith(`/${e.path}`)),
		);
		if (fileWide !== undefined) continue;

		let contents: string;
		try {
			contents = readFileSync(resolve(ROOT, path), "utf-8");
		} catch (err) {
			throw new GuardError(`Cannot read the tracked file ${path}: ${(err as Error).message}`);
		}
		// Binary is decided from the head, as git does. Testing the whole string
		// let one stray NUL anywhere in a text file disable its entire scan.
		if (contents.slice(0, BINARY_SNIFF_BYTES).includes("\0")) continue;
		if (!contents.includes(OLD_FOLDER)) continue;

		const lines = contents.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (REFERENCE.test(lines[i]) && allowedReason(path, lines[i]) === undefined) {
				found.push({ path, line: i + 1, text: lines[i].trim() });
			}
		}
	}
	return found;
}

function verifyDotFolder(): number {
	const references = findReferences();

	if (references.length > 0) {
		const files = new Set(references.map((reference) => reference.path));
		console.error(
			`\n❌ ${references.length} reference(s) to the old \`${OLD_FOLDER}\` folder remain in ${files.size} file(s):\n`,
		);
		for (const reference of references) {
			const text = reference.text.length > 100 ? `${reference.text.slice(0, 100)}…` : reference.text;
			const where = reference.line === 0 ? reference.path : `${reference.path}:${reference.line}`;
			console.error(`   • ${where}  ${text}`);
		}
		console.error(
			`\nThe hidden folder is \`${NEW_FOLDER}\`. Each reference above is built by its own\n` +
				`\`join(...)\` call, shell step or tsconfig \`include\`, so one left behind still builds and\n` +
				"passes its unit tests, then fails at a path that does not exist — or reads a different\n" +
				"file, since an absent config falls back to unscoped names rather than failing. A file\n" +
				`still at the old path is worse: nothing reads it, and the e2e \`projectId\` it pins is\n` +
				`replaced by a fresh random one, so e2e traffic stops being excluded and counts as real.\n` +
				`Rename it (\`git mv\`), or add the path to ALLOWED in scripts/dot-folder-guard.ts with the\n` +
				`reason it keeps the old name.\n`,
		);
		return 1;
	}

	console.log(`✓ No tracked file names the old \`${OLD_FOLDER}\` folder; it is \`${NEW_FOLDER}\` throughout.`);
	return 0;
}

/**
 * `.cdk-blocks/local/` must ignore itself, so a scaffolded app cannot commit its
 * local Building Block data.
 *
 * The hidden folder is committed for `config.json`, so the data under it is only
 * uncommittable while the nested marker exists. Keeping it out of git used to take
 * a negation for the test apps plus a re-ignore of the data under it, three root
 * rules a later edit can break one of; a directory that carries its own rule
 * cannot be un-ignored by an edit elsewhere.
 *
 * Asserted in a throwaway repo rather than in this one, because this monorepo
 * ignores `.cdk-blocks/` wholesale: here the root rule would always answer first,
 * and the assertion would pass whether or not the marker is written.
 *
 * This step writes the marker itself, so on its own it checks git's `.gitignore`
 * semantics, not that the product writes the marker. That the real
 * `getMockDataDir` writes it, and that git attributes the data to it, is asserted
 * in `packages/core/src/common/mock-data.test.ts`. A real scaffold is also
 * covered twice over: every template's `gitignore` lists `.cdk-blocks/local/`,
 * so the root rule answers there even before the marker exists.
 */
function verifyDataIgnored(): number {
	const dir = mkdtempSync(join(tmpdir(), "dot-folder-guard-data-"));
	try {
		execFileSync("git", ["-C", dir, "init", "-q", "."], { stdio: "ignore" });
		writeFileSync(join(dir, ".gitignore"), "node_modules\n");
		mkdirSync(join(dir, MOCK_DATA_RELATIVE, "guard-probe"), { recursive: true });
		writeFileSync(join(dir, ".cdk-blocks", "config.json"), '{"stackId":"guard"}\n');

		// What getMockDataDir writes when it creates the directory.
		writeFileSync(join(dir, ".cdk-blocks", "local", ".gitignore"), "*\n");
		const probe = join(MOCK_DATA_RELATIVE, "guard-probe", "store.json");
		writeFileSync(join(dir, probe), "{}\n");

		let rule: string;
		try {
			rule = execFileSync("git", ["-C", dir, "check-ignore", "-v", probe], { encoding: "utf-8" });
		} catch (err) {
			const status = (err as { status?: number }).status;
			if (status !== 1) throw new GuardError(`Cannot ask git whether ${probe} is ignored: ${(err as Error).message}`);
			console.error(
				`\n❌ ${MOCK_DATA_RELATIVE} is NOT git-ignored in a scaffolded app.\n\n` +
					"A test app's local Building Block data would be committable. `getMockDataDir`\n" +
					"writes `.cdk-blocks/local/.gitignore` containing `*` when it creates the\n" +
					"directory; restore that, rather than adding a rule to the root .gitignore.\n",
			);
			return 1;
		}
		if (!rule.includes(join(".cdk-blocks", "local", ".gitignore"))) {
			console.error(
				`\n❌ ${MOCK_DATA_RELATIVE} is ignored by \`${rule.trim()}\`, not by the nested marker.\n`,
			);
			return 1;
		}

		// The committed config must stay addable, and `clean -fdX` must still reach the data.
		execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
		const staged = execFileSync("git", ["-C", dir, "diff", "--cached", "--name-only"], { encoding: "utf-8" });
		if (!staged.includes(".cdk-blocks/config.json")) {
			console.error("\n❌ The committed .cdk-blocks/config.json is no longer addable.\n");
			return 1;
		}
		if (staged.includes("local/data")) {
			console.error("\n❌ `git add -A` staged the local data.\n");
			return 1;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
	}
	console.log(`✓ ${MOCK_DATA_RELATIVE} ignores itself in a scaffolded app; the committed config stays tracked.`);
	return 0;
}

/**
 * Trap 4: a renamed path that no longer names anything real.
 *
 * `.blocks.dart` is the Dart codegen's OUTPUT extension, not the hidden folder, so a
 * blanket `.blocks` -> `.cdk-blocks` substitution turns a runnable doc snippet into an
 * import of a file the builder never writes. Nothing else catches it: the name is
 * consistent with itself, so an old-name scan passes and the build never reads a README.
 *
 * The expected extension is READ FROM THE BUILDER rather than hard-coded, so the check
 * follows a deliberate rename instead of pinning today's value.
 */
function verifyCodegenExtension(): number {
	const builder = "native/dart/packages/blocks_codegen/lib/builder.dart";
	const buildYaml = "native/dart/packages/blocks_codegen/build.yaml";
	const offenders: string[] = [];

	let source: string;
	try {
		source = readFileSync(resolve(ROOT, builder), "utf-8");
	} catch {
		console.error(`\n❌ ${builder} is missing — the Dart codegen extension cannot be verified.\n`);
		return 1;
	}
	const declared = /'\.spec\.json':\s*\[\s*'([^']+)'/.exec(source)?.[1];
	if (declared === undefined) {
		console.error(`\n❌ Could not read buildExtensions from ${builder}.\n`);
		return 1;
	}

	// build.yaml carries the same mapping for the published builder; a split is its own bug.
	try {
		const yaml = readFileSync(resolve(ROOT, buildYaml), "utf-8");
		const inYaml = /build_extensions:\s*\{\s*"\.spec\.json":\s*\[\s*"([^"]+)"/.exec(yaml)?.[1];
		if (inYaml !== undefined && inYaml !== declared) {
			offenders.push(`${buildYaml}  declares ${inYaml} but ${builder} declares ${declared}`);
		}
	} catch {
		/* no build.yaml */
	}

	// Every generated-client import in a doc must name the extension the builder writes.
	const importRe = /import\s+'([^']*\.dart)'/g;
	for (const path of trackedFiles()) {
		if (!path.endsWith(".md")) continue;
		let text: string;
		try {
			text = readFileSync(resolve(ROOT, path), "utf-8");
		} catch {
			continue;
		}
		for (const m of text.matchAll(importRe)) {
			const spec = m[1] ?? "";
			// only a generated client: `<spec name>.<ext>`, never a hand-written library
			if (!/^[\w.-]+\.[\w-]+\.dart$/.test(spec)) continue;
			if (!spec.endsWith(declared)) {
				const line = text.slice(0, m.index).split("\n").length;
				offenders.push(`${path}:${line}  imports ${spec}, but the builder writes ${declared}`);
			}
		}
	}

	if (offenders.length > 0) {
		console.error(`\n❌ ${offenders.length} doc snippet(s) name a Dart file the codegen never writes:\n`);
		for (const o of offenders) console.error(`   • ${o}`);
		console.error(`\n   The codegen output extension is ${declared}; it is NOT the hidden folder.\n`);
		return 1;
	}
	console.log(`✓ Every Dart generated-client import in a doc names the builder's ${declared}.`);
	return 0;
}

/**
 * LIFETIME. Two of these outlive the rename and two do not, which is why they
 * are one command rather than four:
 *   - trap 1 (a multi-segment path compared against single path segments) and
 *     trap 4 (a doc naming a generated-file extension that disagrees with the
 *     builder) are not about `.blocks` at all. They are shape errors any later
 *     path or codegen change can reintroduce, and trap 1 has already caught two
 *     live instances nobody was looking for, so they stay.
 *   - trap 2 (a `LEGACY*` constant holding the NEW name) and trap 3 (a comment
 *     reflow merging two commands onto one line) are specific to this migration.
 *     Delete them with `LEGACY_BLOCKS_DIR`, once no constant names the old folder.
 * Keeping all four until then costs one CI step that runs in well under a second.
 *
 * The four mistakes this rename made more than once, each asserted rather than
 * left to review.
 *
 *  1. A MULTI-SEGMENT path used where a single path SEGMENT is compared. The data
 *     directory used to be one segment (`.bb-data`), so `parts.includes(...)` and
 *     `Set.has(seg)` worked; `.cdk-blocks/local/data` is three and can never match.
 *     It silently disabled a bench persistence check and an agent-bench exclusion.
 *  2. A LEGACY constant holding the NEW name. The whole point of such a constant is
 *     the pre-rename value, and a blanket rename rewrote two of them — which makes
 *     every fallback that reads it look in a directory that by definition does not
 *     exist on the app it is for.
 *  3. A pre-formatted, indented comment block reflowed as prose, which merges one
 *     documented command into the next.
 */
function verifyRenameTraps(): number {
	const offenders: string[] = [];
	const multiSegment = /(['"`])\.cdk-blocks\/(local|data)[^'"`]*\1/;

	for (const path of trackedFiles()) {
		if (path === "scripts/dot-folder-guard.ts") continue;
		let text: string;
		try {
			text = readFileSync(resolve(ROOT, path), "utf-8");
		} catch {
			continue;
		}
		if (text.slice(0, BINARY_SNIFF_BYTES).includes("\0")) continue;

		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// 1. a multi-segment path on a line that compares single segments
			const comparesSegments = /\bparts\b|relative_to|split\((sep|['"`]\/['"`])\)|EXCLUDE_DIRS|SKIP_DIRS/.test(line);
			if (multiSegment.test(line) && comparesSegments && !path.endsWith(".md")) {
				offenders.push(`${path}:${i + 1}  a multi-segment path cannot equal one path segment: ${line.trim()}`);
			}

			// 2. a legacy constant holding the new name
			if (/LEGACY[A-Z_]*\s*[:=]/.test(line) && /\.cdk-blocks/.test(line)) {
				offenders.push(`${path}:${i + 1}  a LEGACY constant must hold the PRE-rename name: ${line.trim()}`);
			}

			// 3. two shell commands merged onto one comment line by a reflow
			if (/^\s*(\*|\/\/|#)/.test(line) && /(npx|npm run)\s+\S+.*\s(npx|npm run)\s*$/.test(line)) {
				offenders.push(`${path}:${i + 1}  a reflow merged the next command onto this usage line: ${line.trim()}`);
			}
		}
	}

	if (offenders.length > 0) {
		console.error(`\n❌ ${offenders.length} rename trap(s):\n`);
		for (const o of offenders) console.error(`   • ${o}`);
		console.error("");
		return 1;
	}
	console.log("✓ No multi-segment segment comparison, mis-valued LEGACY constant or merged usage line.");
	return 0;
}

function main(): number {
	const command = process.argv[2];

	switch (command) {
		case "verify-dot-folder":
			return verifyDotFolder();
		case "verify-rename-traps":
			return verifyRenameTraps() || verifyCodegenExtension();
		case "verify-data-ignored":
			return verifyDataIgnored();
		default:
			console.error(
				`Unknown command: ${command ?? "(none)"}\n` +
					"Usage: node --experimental-strip-types scripts/dot-folder-guard.ts " +
					"<verify-dot-folder|verify-data-ignored|verify-rename-traps>",
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
