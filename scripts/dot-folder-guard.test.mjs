// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Runs the real guard against temporary Git repositories; no filesystem or Git calls are stubbed.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const GUARD_SRC = join(SCRIPTS_DIR, "dot-folder-guard.ts");

// CI runs the pinned Node (.nvmrc), which strips types natively. Older local
// Node builds without --experimental-strip-types fall back to the repo's tsx, so
// the suite is runnable on a laptop too.
const TSX_BIN = join(SCRIPTS_DIR, "..", "node_modules", ".bin", "tsx");
const STRIPS_TYPES = Number(process.versions.node.split(".")[0]) >= 22;

// Keeps the fixture repo free of the host's git config (signing hooks, aliases,
// templates) so the tests behave the same on a laptop and on a runner.
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "Guard Test",
	GIT_AUTHOR_EMAIL: "guard@test.invalid",
	GIT_COMMITTER_NAME: "Guard Test",
	GIT_COMMITTER_EMAIL: "guard@test.invalid",
};

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" });
}

function write(dir, relPath, contents) {
	const full = join(dir, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, contents);
}

/**
 * A fixture repo holding `files`, with everything committed so git tracks it.
 * `track: false` leaves the files in the working tree without committing them.
 */
function repo(t, files, { track = true } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "dot-folder-guard-"));
	// Retry the removal: a git child process can still be writing into `.git`
	// when the test ends, and a single pass then fails with ENOTEMPTY / EBUSY
	// in the hook (failing the test although its assertions passed).
	t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

	mkdirSync(join(dir, "scripts"), { recursive: true });
	copyFileSync(GUARD_SRC, join(dir, "scripts", "dot-folder-guard.ts"));

	for (const [relPath, contents] of Object.entries(files)) write(dir, relPath, contents);

	git(dir, "init", "--quiet");
	if (track) {
		git(dir, "add", "--all");
		git(dir, "commit", "--quiet", "--message", "fixture");
	}
	return dir;
}

/** Run the guard in `dir`, returning its exit code and combined output. */
function run(dir) {
	const guard = join(dir, "scripts", "dot-folder-guard.ts");
	const [command, args] =
		STRIPS_TYPES || !existsSync(TSX_BIN)
			? [process.execPath, ["--experimental-strip-types", guard, "verify-dot-folder"]]
			: [TSX_BIN, [guard, "verify-dot-folder"]];
	try {
		const stdout = execFileSync(command, args, { cwd: dir, encoding: "utf-8", stdio: "pipe" });
		return { code: 0, output: stdout };
	} catch (err) {
		return { code: err.status, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

describe("dot-folder-guard verify-dot-folder", () => {
	void it("passes a repo that names only the new folder", (t) => {
		const dir = repo(t, {
			"packages/core/src/consent.ts": "join(homedir(), '.cdk-blocks', 'config.json');\n",
			".gitignore": ".cdk-blocks/\n",
		});
		const { code, output } = run(dir);
		assert.equal(code, 0, output);
		assert.match(output, /No tracked file names the old/);
	});

	void it("fails and names the file when one reference is left behind", (t) => {
		const dir = repo(t, {
			"packages/core/src/consent.ts": "join(homedir(), '.cdk-blocks', 'config.json');\n",
			// The case the guard exists for: a second join() in another package,
			// which builds and unit-tests cleanly with the old name.
			"packages/core/src/stack-id.ts": "const p = join(root, '.blocks', 'config.json');\n",
		});
		const { code, output } = run(dir);
		assert.equal(code, 1, output);
		assert.match(output, /packages\/core\/src\/stack-id\.ts:1/);
		assert.match(output, /1 reference\(s\)/);
		// The passing file must not be reported as a failure.
		assert.doesNotMatch(output, /consent\.ts/);
	});

	void it("reports every remaining reference, not just the first", (t) => {
		const dir = repo(t, {
			"a.ts": "join(root, '.blocks', 'config.json');\n",
			"b.yml": 'mkdir -p "$HOME/.blocks/telemetry"\n',
			"c/tsconfig.json": '{ "include": [".blocks/**/*.d.ts"] }\n',
		});
		const { code, output } = run(dir);
		assert.equal(code, 1, output);
		assert.match(output, /3 reference\(s\) to the old `\.blocks` folder remain in 3 file\(s\)/);
	});

	void it("leaves the sibling .blocks-sandbox directory and suffixed names alone", (t) => {
		const dir = repo(t, {
			"a.ts": "join(root, '.blocks-sandbox', 'config.json');\n",
			"b.ts": "const d = '.blocks-data';\nconst e = '.blocks-iam.json';\n",
			".gitignore": ".blocks-sandbox/\n",
		});
		const { code, output } = run(dir);
		assert.equal(code, 0, output);
	});

	void it("flags a bare trailing `?`, which is prose rather than the package.json key", (t) => {
		// `.blocks?.dev` is the optional-chained key and stays exempt; `~/.blocks?`
		// ending a question is exactly where a stale reference survives a rename.
		const dir = repo(t, {
			"ok.ts": "const dev = readPackageJson(root).blocks?.dev;\n",
			"prose.md": "Is the installation id still in `~/.blocks?`\n",
		});
		const { code, output } = run(dir);
		assert.equal(code, 1, output);
		assert.match(output, /prose\.md/);
		assert.doesNotMatch(output, /ok\.ts/);
	});

	void it("leaves the reverse-DNS package names and the package.json blocks key alone", (t) => {
		const dir = repo(t, {
			"A.kt": "package com.aws.blocks.kotlin\nimport com.example.blocks.Thing\n",
			// Read off a call and an index result: the two shapes whose leading
			// character is punctuation, so only excluding identifiers misses them.
			"b.ts": "const dev = readPackageJson(root).blocks?.dev;\nconst p = apps[0].blocks;\n",
			"c.ts": "const t = result.blocks;\nconst u = payload.__blocksType;\n",
		});
		const { code, output } = run(dir);
		assert.equal(code, 0, output);
	});

	void it("leaves a property read written inside a regex literal alone", (t) => {
		// `\.blocks` after an escaped `)` is the `package.json` key read, matched
		// as generated source text. Flagging it renamed a test's regex and broke
		// what it matched, which is why the leading boundary looks past the
		// backslash. Caught in review of the rename this guard protects.
		const dir = repo(t, {
			"a.test.ts": String.raw`const m = source.match(/JSON\.parse\(readFileSync\(p\)\)\.blocks\?\.dev\?\.port/);` + "\n",
			"b.test.ts": String.raw`assert.match(x, /apps\[0\]\.blocks/);` + "\n",
		});
		const { code, output } = run(dir);
		assert.equal(code, 0, output);
	});

	void it("flags a Windows path separator and a folder path inside a regex literal", (t) => {
		// The mirror of the case above: a bare backslash before the dot is a path
		// separator, not an escape, so these are the folder and must be caught.
		const dir = repo(t, {
			"win.yml": String.raw`- Path: "$env:USERPROFILE\.blocks\telemetry"` + "\n",
			"a.test.ts": String.raw`assert.match(m, /\.blocks\/config\.json not found/);` + "\n",
		});
		const { code, output } = run(dir);
		assert.equal(code, 1, output);
		assert.match(output, /2 reference\(s\)/);
		assert.match(output, /win\.yml:1/);
		assert.match(output, /a\.test\.ts:1/);
	});

	void it("leaves optional chaining and a spread of a variable named blocks alone", (t) => {
		// Both renamed real code during review: `data?.blocks` became
		// `data?.cdk-blocks`, which parses as a subtraction, and `[...blocks]`
		// became `[...cdk-blocks]`. The build caught them; the guard had not.
		const dir = repo(t, {
			"a.ts": "const list = data?.blocks ?? [];\nconst n = discovery?.blocks;\n",
			"b.ts": "const reversed = [...blocks].reverse();\n",
		});
		const { code, output } = run(dir);
		assert.equal(code, 0, output);
	});

	void it("counts the path boundaries that are not a property read", (t) => {
		// Enumerated from the tree: quote, backtick, double quote, space, slash,
		// parent path, open paren and a JSX `>` all introduce the folder.
		const dir = repo(t, {
			"a.ts": "join(root, '.blocks', 'config.json');\n",
			"b.ts": "const p = `.blocks/config.json`;\n",
			"c.sh": 'mkdir -p "$HOME/.blocks/telemetry"\n',
			"d.md": "The id lives in .blocks and is committed.\n",
			"e.json": '{ "include": ["../.blocks/**/*.d.ts"] }\n',
			"f.ts": "// Reads project state (.blocks/, package.json).\n",
			"g.tsx": "<code>.blocks/deploy-history.jsonl</code>\n",
		});
		const { code, output } = run(dir);
		assert.equal(code, 1, output);
		assert.match(output, /7 reference\(s\) to the old `\.blocks` folder remain in 7 file\(s\)/);
	});

	void it("flags a tracked file still at the old path, whose content names nothing", (t) => {
		// The silent half of the rename. A committed test-app config pins an e2e
		// projectId in the all-zero space and holds no text naming the folder, so
		// a content-only scan calls the tree clean while the file sits where
		// nothing reads it; getProjectId() then mints a v4 UUID, which can never
		// start with 00000000-0000-0000-0000-, and e2e traffic stops being
		// excluded. The suite still passes, so only the guard catches this.
		const dir = repo(t, {
			"test-apps/comprehensive/.blocks/config.json":
				'{\n  "telemetry": {\n    "projectId": "00000000-0000-0000-0000-000000000e2e"\n  }\n}\n',
		});
		const { code, output } = run(dir);
		assert.equal(code, 1, output);
		assert.match(output, /test-apps\/comprehensive\/\.blocks\/config\.json {2}this file is still at the old path/);
		// Reported as a location, not as a line inside the file.
		assert.doesNotMatch(output, /config\.json:\d/);
	});

	void it("does not flag a path under the sibling .blocks-sandbox directory", (t) => {
		// That directory keeps its name, and a template really does ship a route
		// at this path, so a segment-anchored path check is what keeps it quiet.
		const dir = repo(t, {
			"packages/create-blocks-app/templates/nextjs/src/app/.blocks-sandbox/config.json/route.ts":
				"export const GET = () => new Response('{}');\n",
		});
		const { code, output } = run(dir);
		assert.equal(code, 0, output);
	});

	void it("allows the published changelogs and the native clients' own storage directory", (t) => {
		const dir = repo(t, {
			"packages/core/CHANGELOG.md": "Writes `.blocks/config.json` at the project root.\n",
			"native/kotlin/runtime/src/jvmMain/Storage.jvm.kt": 'private const val DIR = ".blocks"\n',
			"native/kotlin/README.md": "Encrypted files under `~/.blocks/<applicationId>`.\n",
			// The other two ALLOWED entries, each load-bearing on the real tree:
			// the changeset has to name the old folder to give the `git mv`
			// instruction, and the migrate fixtures are snapshots of past
			// releases' wrappers, matched by the SHA-256 of their source.
			".changeset/cdk-blocks-dot-folder.md": "Rename `.blocks/` to `.cdk-blocks/`: `git mv .blocks .cdk-blocks`.\n",
			"packages/blocks/test-fixtures/migrate-apps.json":
				'{ "default@0ab6b047": { "typegen.ts": "// Generate .blocks/hosting-values.d.ts\\n" } }\n',
		});
		const { code, output } = run(dir);
		assert.equal(code, 0, output);
	});

	void it("fails rather than skipping when a tracked file cannot be read", (t) => {
		// The fail-loud promise in the guard's header: an unreadable file is a
		// file whose references were not checked, so it must not be reported as
		// clean. Without this, turning the throw into a `continue` left the
		// suite green while CI would print the guard's success line.
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			t.skip("root bypasses file permissions, so the file stays readable");
			return;
		}
		const dir = repo(t, { "secret.ts": "const x = 1;\n" });
		// `repo`'s own cleanup removes the directory, which succeeds on a
		// mode-000 file, so no restore hook is needed.
		chmodSync(join(dir, "secret.ts"), 0o000);
		const { code, output } = run(dir);
		assert.equal(code, 1, output);
		assert.match(output, /Cannot read the tracked file secret\.ts/);
	});

	void it("does not read untracked files", (t) => {
		// A developer's own ignored `.blocks/` working data, and a scratch file:
		// neither ships, so neither is the rename's business.
		const dir = repo(t, { "committed.ts": "const x = 1;\n" });
		write(dir, "scratch.ts", "join(root, '.blocks', 'config.json');\n");
		write(dir, ".blocks/config.json", '{ "stackId": "demo" }\n');
		const { code, output } = run(dir);
		assert.equal(code, 0, output);
	});

	void it("fails rather than passing vacuously when git tracks nothing", (t) => {
		const dir = repo(t, { "a.ts": "join(root, '.blocks', 'x');\n" }, { track: false });
		const { code, output } = run(dir);
		assert.equal(code, 1, output);
		assert.match(output, /tracks no files/);
	});

	void it("scopes each allowlist entry, so a sibling file or a wider directory is not exempt", (t) => {
		// All three were proven to escape while the entries were inferred rather
		// than declared: `native/` exempted ~1,100 files, `CHANGELOG.md` was a
		// bare suffix, and a file entry was a prefix so its `.old` sibling passed.
		const dir = repo(t, {
			"native/x/leak.ts": 'readFileSync(join(homedir(), ".blocks", "telemetry", "installation-id"));\n',
			"packages/core/src/MY-CHANGELOG.md": 'join(home, ".blocks/config.json")\n',
			"scripts/dot-folder-guard.ts.old": 'join(home, ".blocks/config.json")\n',
		});
		const { code, output } = run(dir);
		assert.equal(code, 1, output);
		assert.match(output, /3 reference\(s\)/);
	});

	void it("keeps the Kotlin client's own storage directory exempt", (t) => {
		const dir = repo(t, {
			"native/kotlin/runtime/src/jvmMain/S.kt": 'const val D = ".blocks"\n',
			"native/kotlin/README.md": "Files under `~/.blocks/<applicationId>`.\n",
		});
		const { code, output } = run(dir);
		assert.equal(code, 0, output);
	});

	void it("catches a trailing dot in prose but not an extension or a wrapped property read", (t) => {
		// `~/.blocks.` ending a sentence is where a stale reference survives a
		// rename. `.blocks.dart` is the Dart codegen's output extension, and a
		// formatter-wrapped `.blocks.dev` / `.blocks?.dev` is the package.json key
		// on its own line - 821 such continuation lines exist in this repo, so
		// flagging them would red-light legitimate code.
		const flagged = repo(t, { "a.md": "the config lives in ~/.blocks.\n" });
		assert.equal(run(flagged).code, 1);
		const clean = repo(t, {
			"b.yaml": 'build_extensions: {".spec.json": [".blocks.dart"]}\n',
			"c.ts": "const v = readPackageJson(root)\n\t.blocks?.dev;\n",
			"d.ts": "const w = readPackageJson(root)\n\t.blocks.dev;\n",
		});
		const { code, output } = run(clean);
		assert.equal(code, 0, output);
	});

	void it("does not let a non-ASCII package name look like a path", (t) => {
		// `com.caf\u00e9.blocks.iot` in the Kotlin codegen tests: the character before
		// `.blocks` is outside ASCII, so an `A-Za-z0-9` leading class missed it.
		// The package-name form is also covered by the trailing rule, so the case
		// that isolates the leading class is a property read whose follower is NOT
		// an identifier: an ASCII-only class flags `caf\u00e9.blocks;` as a path.
		const dir = repo(t, {
			"a.kt": "import com.caf\u00e9.blocks.iot.DeviceLink\n",
			"b.ts": "const x = caf\u00e9.blocks;\nconst y = \u0441\u0442\u043e\u0440.blocks;\n",
		});
		const { code, output } = run(dir);
		assert.equal(code, 0, output);
	});

	void it("still scans a text file that holds a stray NUL past the sniff window", (t) => {
		// Testing the whole string for NUL let one byte disable a file's scan.
		const dir = repo(t, {
			"a.ts": `const p = join(home, ".blocks", "c.json");\n${"x".repeat(9000)}\0\n`,
		});
		const { code, output } = run(dir);
		assert.equal(code, 1, output);
		assert.match(output, /a\.ts:1/);
	});

	void it("flags a file committed at the old path even inside an allowed directory", (t) => {
		// Every allowlist entry exists because a file's CONTENT must name the old
		// folder; none is a reason to COMMIT one at the old path. Checking the
		// allowlist first disabled both checks for a whole directory.
		const dir = repo(t, {
			"native/kotlin/runtime/src/jvmMain/.blocks/config.json": '{ "stackId": "x" }\n',
		});
		const { code, output } = run(dir);
		assert.equal(code, 1, output);
		assert.match(output, /this file is still at the old path/);
	});

	void it("exits 2 on an unknown command", (t) => {
		const dir = repo(t, { "a.ts": "const x = 1;\n" });
		const guard = join(dir, "scripts", "dot-folder-guard.ts");
		const [command, args] =
			STRIPS_TYPES || !existsSync(TSX_BIN)
				? [process.execPath, ["--experimental-strip-types", guard, "nope"]]
				: [TSX_BIN, [guard, "nope"]];
		let code = 0;
		let output = "";
		try {
			output = execFileSync(command, args, { cwd: dir, encoding: "utf-8", stdio: "pipe" });
		} catch (err) {
			code = err.status;
			output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
		}
		assert.equal(code, 2, output);
		assert.match(output, /Unknown command: nope/);
	});
});
