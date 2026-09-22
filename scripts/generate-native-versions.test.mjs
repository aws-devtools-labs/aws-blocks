// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/generate-native-versions.mjs. Drift cases copy the real
// script into a temp repo (it roots at `import.meta.url/..`) and runs it for real:
// real fs, no stubs. The swift target drives the generic drift cases; its
// .swiftformat header source is supplied by the swiftRepo helper.
//
// Run: node --test scripts/generate-native-versions.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const SCRIPTS_DIR = import.meta.dirname;
const SCRIPT_SRC = join(SCRIPTS_DIR, "generate-native-versions.mjs");
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const SWIFT_PKG = "native/swift/package.json";
const SWIFT_CONFIG = "native/swift/.swiftformat";
const SWIFT_TARGET = "native/swift/Sources/BlocksRuntime/Version.swift";

// Runs the script for real, returning { status, output }. execFileSync raises on
// a non-zero exit, so that case is unwrapped rather than propagated.
function run(args, cwd = REPO_ROOT, script = SCRIPT_SRC) {
	try {
		const output = execFileSync(process.execPath, [script, ...args], { cwd, encoding: "utf-8" });
		return { status: 0, output };
	} catch (err) {
		return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

function write(dir, relPath, contents) {
	const full = join(dir, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, contents);
}

// A throwaway repo holding a copy of the real script (which roots at its own
// dir/..) plus the given source-of-truth files. Cleaned up when the test ends.
function makeRepo(t, files) {
	const dir = mkdtempSync(join(tmpdir(), "gen-native-versions-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "scripts"), { recursive: true });
	copyFileSync(SCRIPT_SRC, join(dir, "scripts", "generate-native-versions.mjs"));
	for (const [rel, contents] of Object.entries(files)) {
		write(dir, rel, contents);
	}
	return dir;
}

const scriptIn = (dir) => join(dir, "scripts", "generate-native-versions.mjs");

const HEADER_LINE = '--header "//\\n// Copyright Example.\\n//"\n';
const swiftRepo = (t, { version = "9.9.9", config = HEADER_LINE } = {}) => {
	const dir = makeRepo(t, { [SWIFT_PKG]: JSON.stringify({ version }), [SWIFT_CONFIG]: config });
	mkdirSync(join(dir, "native/swift/Sources/BlocksRuntime"), { recursive: true });
	return dir;
};

describe("generate-native-versions --check against the real repo", () => {
	it("passes for the committed Swift constant", () => {
		const { status, output } = run(["--swift", "--check"]);
		assert.equal(status, 0, output);
		assert.match(output, /ok\s+swift/);
	});
});

describe("generate-native-versions argument handling", () => {
	it("exits 1 with usage when no target is given", () => {
		const { status, output } = run([]);
		assert.equal(status, 1, output);
		assert.match(output, /Usage:/);
	});

	it("exits 1 on an unknown target", () => {
		const { status, output } = run(["nope"]);
		assert.equal(status, 1, output);
		assert.match(output, /Unknown target/);
	});

	it("exits 1 on a mistyped flag instead of silently ignoring it", () => {
		const { status, output } = run(["--swift", "--chekc"]);
		assert.equal(status, 1, output);
		assert.match(output, /Unknown flag/);
	});
});

describe("generate-native-versions drift detection (swift, temp repo)", () => {
	it("reports DRIFT and exits 1 when the target is missing", (t) => {
		const dir = swiftRepo(t);
		const { status, output } = run(["--swift", "--check"], dir, scriptIn(dir));
		assert.equal(status, 1, output);
		assert.match(output, /DRIFT/);
	});

	it("generates a file that then passes --check", (t) => {
		const dir = swiftRepo(t);
		const gen = run(["--swift"], dir, scriptIn(dir));
		assert.equal(gen.status, 0, gen.output);
		assert.match(readFileSync(join(dir, SWIFT_TARGET), "utf-8"), /public let blocksRuntimeVersion = "9\.9\.9"/);

		const check = run(["--swift", "--check"], dir, scriptIn(dir));
		assert.equal(check.status, 0, check.output);
		assert.match(check.output, /ok\s+swift/);
	});

	it("reports DRIFT and exits 1 after the committed file is edited by hand", (t) => {
		const dir = swiftRepo(t);
		run(["--swift"], dir, scriptIn(dir));
		writeFileSync(join(dir, SWIFT_TARGET), "// tampered\n");
		const { status, output } = run(["--swift", "--check"], dir, scriptIn(dir));
		assert.equal(status, 1, output);
		assert.match(output, /DRIFT/);
	});

	it("tolerates CRLF line endings (Windows checkout)", (t) => {
		const dir = swiftRepo(t);
		run(["--swift"], dir, scriptIn(dir));
		const target = join(dir, SWIFT_TARGET);
		writeFileSync(target, readFileSync(target, "utf-8").replaceAll("\n", "\r\n"));
		const { status, output } = run(["--swift", "--check"], dir, scriptIn(dir));
		assert.equal(status, 0, output);
		assert.match(output, /ok\s+swift/);
	});

	it("exits 1 when the version carries build metadata (+build)", (t) => {
		const dir = swiftRepo(t, { version: "9.9.9+5" });
		const { status, output } = run(["--swift"], dir, scriptIn(dir));
		assert.equal(status, 1, output);
		assert.match(output, /not a valid token semver/);
	});
});

describe("generate-native-versions Swift header sourcing (temp repo)", () => {
	it("reads the header from .swiftformat into the generated file", (t) => {
		const dir = swiftRepo(t);
		const { status, output } = run(["--swift"], dir, scriptIn(dir));
		assert.equal(status, 0, output);
		const written = readFileSync(join(dir, SWIFT_TARGET), "utf-8");
		// The escaped \n pairs in the config become real newlines in the output.
		assert.match(written, /^\/\/\n\/\/ Copyright Example\.\n\/\//);
		assert.match(written, /public let blocksRuntimeVersion = "9\.9\.9"/);
	});

	it("exits 1 with a clear message when .swiftformat is missing", (t) => {
		const dir = makeRepo(t, { [SWIFT_PKG]: JSON.stringify({ version: "9.9.9" }) });
		const { status, output } = run(["--swift"], dir, scriptIn(dir));
		assert.equal(status, 1, output);
		assert.match(output, /Cannot read .*\.swiftformat/);
	});

	it("exits 1 when --header carries no quoted value (e.g. strip)", (t) => {
		const dir = swiftRepo(t, { config: "--header strip\n" });
		const { status, output } = run(["--swift"], dir, scriptIn(dir));
		assert.equal(status, 1, output);
		assert.match(output, /No quoted --header value/);
	});

	it("exits 1 when package.json version is not a string", (t) => {
		const dir = makeRepo(t, { [SWIFT_PKG]: JSON.stringify({ version: 1 }), [SWIFT_CONFIG]: HEADER_LINE });
		const { status, output } = run(["--swift"], dir, scriptIn(dir));
		assert.equal(status, 1, output);
		assert.match(output, /No version found/);
	});
});
