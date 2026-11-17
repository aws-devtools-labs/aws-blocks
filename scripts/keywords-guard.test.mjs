// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/keywords-guard.ts. Every case builds a throwaway
// workspace in a temp dir and copies the real guard into its scripts/ (the guard
// roots itself at `import.meta.dirname/..`, so the copy sees the fixture as the
// repo), then runs the guard for real: real fs, no stubs.
//
// Run: node --test scripts/keywords-guard.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const GUARD_SRC = join(SCRIPTS_DIR, "keywords-guard.ts");

// CI runs the pinned Node (.nvmrc), which strips types natively. Older local
// Node builds without --experimental-strip-types fall back to the repo's tsx, so
// the suite is runnable on a laptop too.
const TSX_BIN = join(SCRIPTS_DIR, "..", "node_modules", ".bin", "tsx");
const STRIPS_TYPES = Number(process.versions.node.split(".")[0]) >= 22;
function runner(guardPath, command) {
	return STRIPS_TYPES || !existsSync(TSX_BIN)
		? [process.execPath, ["--experimental-strip-types", guardPath, command]]
		: [TSX_BIN, [guardPath, command]];
}

const DISCOVERY_KEYWORD = "aws-blocks";
const UMBRELLA = "@aws-blocks/blocks";
const SIBLING = "@aws-blocks/core";

function write(dir, relPath, contents) {
	const full = join(dir, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, contents);
}

function pkgJson(name, extra = {}) {
	return `${JSON.stringify({ name, version: "0.1.0", ...extra }, null, 2)}\n`;
}

/**
 * A fixture workspace whose packages/ holds two tagged publishable packages.
 * `files` is merged over that layout; `null` omits an entry.
 */
function baseRepo(t, files = {}) {
	const dir = mkdtempSync(join(tmpdir(), "keywords-guard-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	mkdirSync(join(dir, "scripts"), { recursive: true });
	copyFileSync(GUARD_SRC, join(dir, "scripts", "keywords-guard.ts"));

	const layout = {
		"package.json": `${JSON.stringify({ name: "fixture-root", private: true }, null, 2)}\n`,
		"packages/blocks/package.json": pkgJson(UMBRELLA, {
			keywords: [DISCOVERY_KEYWORD, "framework"],
		}),
		"packages/core/package.json": pkgJson(SIBLING, {
			keywords: [DISCOVERY_KEYWORD, "primitives"],
		}),
		...files,
	};

	for (const [relPath, contents] of Object.entries(layout)) {
		if (contents === null) continue;
		write(dir, relPath, contents);
	}
	return dir;
}

/**
 * Runs the guard in the fixture and returns its exit code plus combined
 * stdout+stderr. A non-zero exit is the behaviour under test, so the throw
 * execFileSync raises for it is unwrapped rather than propagated.
 */
function guard(dir, command) {
	const [bin, args] = runner(join(dir, "scripts", "keywords-guard.ts"), command);
	try {
		const stdout = execFileSync(bin, args, {
			cwd: dir,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, output: stdout };
	} catch (err) {
		return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

describe("verify-discovery-tag: every published package carries the discovery keyword", () => {
	it("passes when all publishable packages carry it", (t) => {
		const dir = baseRepo(t);

		const { status, output } = guard(dir, "verify-discovery-tag");
		assert.equal(status, 0, output);
		assert.match(output, /All 2 published package\(s\) carry the "aws-blocks" keyword/);
	});

	it("fails and names the package when one is missing it", (t) => {
		const dir = baseRepo(t, {
			"packages/bb-queue/package.json": pkgJson("@aws-blocks/bb-queue", {
				keywords: ["queue", "sqs"],
			}),
		});

		const { status, output } = guard(dir, "verify-discovery-tag");
		assert.equal(status, 1, output);
		assert.match(output, /missing the "aws-blocks" keyword/);
		assert.match(output, /@aws-blocks\/bb-queue {2}\(packages\/bb-queue\/package\.json\)/);
		// The compliant packages must not be reported.
		assert.doesNotMatch(output, /@aws-blocks\/core/);
	});

	it("fails when a package declares no keywords at all", (t) => {
		const dir = baseRepo(t, {
			"packages/bb-queue/package.json": pkgJson("@aws-blocks/bb-queue"),
		});

		const { status, output } = guard(dir, "verify-discovery-tag");
		assert.equal(status, 1, output);
		assert.match(output, /@aws-blocks\/bb-queue/);
	});

	it("fails when keywords is present but not an array", (t) => {
		const dir = baseRepo(t, {
			"packages/bb-queue/package.json": pkgJson("@aws-blocks/bb-queue", {
				keywords: DISCOVERY_KEYWORD,
			}),
		});

		const { status, output } = guard(dir, "verify-discovery-tag");
		assert.equal(status, 1, output);
		assert.match(output, /@aws-blocks\/bb-queue/);
	});

	it("reports every offender, not just the first", (t) => {
		const dir = baseRepo(t, {
			"packages/bb-queue/package.json": pkgJson("@aws-blocks/bb-queue", { keywords: ["queue"] }),
			"packages/bb-cache/package.json": pkgJson("@aws-blocks/bb-cache", { keywords: [] }),
		});

		const { status, output } = guard(dir, "verify-discovery-tag");
		assert.equal(status, 1, output);
		assert.match(output, /@aws-blocks\/bb-queue/);
		assert.match(output, /@aws-blocks\/bb-cache/);
	});

	it("ignores private workspaces, which are never published", (t) => {
		const dir = baseRepo(t, {
			"packages/foundations/package.json": pkgJson("foundations", { private: true, keywords: [] }),
			"packages/bb-internal/package.json": pkgJson("@aws-blocks/bb-internal", {
				private: true,
				keywords: [],
			}),
		});

		const { status, output } = guard(dir, "verify-discovery-tag");
		assert.equal(status, 0, output);
	});

	it("ignores packages outside the @aws-blocks scope", (t) => {
		const dir = baseRepo(t, {
			"packages/unscoped/package.json": pkgJson("some-other-package", { keywords: [] }),
		});

		const { status, output } = guard(dir, "verify-discovery-tag");
		assert.equal(status, 0, output);
	});

	it("substring matches do not satisfy the tag", (t) => {
		const dir = baseRepo(t, {
			"packages/bb-queue/package.json": pkgJson("@aws-blocks/bb-queue", {
				keywords: ["aws-blocks-queue", "aws"],
			}),
		});

		const { status, output } = guard(dir, "verify-discovery-tag");
		assert.equal(status, 1, output);
		assert.match(output, /@aws-blocks\/bb-queue/);
	});

	it("fails loudly on a malformed package.json instead of skipping it", (t) => {
		const dir = baseRepo(t, {
			"packages/bb-queue/package.json": "{ not json",
		});

		const { status, output } = guard(dir, "verify-discovery-tag");
		assert.equal(status, 1, output);
		assert.match(output, /Cannot parse packages\/bb-queue\/package\.json/);
	});

	it("fails rather than passing vacuously when there are no publishable packages", (t) => {
		const dir = baseRepo(t, {
			"packages/blocks/package.json": pkgJson(UMBRELLA, { private: true }),
			"packages/core/package.json": pkgJson(SIBLING, { private: true }),
		});

		const { status, output } = guard(dir, "verify-discovery-tag");
		assert.equal(status, 1, output);
		assert.match(output, /Found no publishable @aws-blocks\/\* packages/);
	});

	it("rejects an unknown subcommand", (t) => {
		const dir = baseRepo(t);

		const { status, output } = guard(dir, "not-a-command");
		assert.equal(status, 2, output);
		assert.match(output, /Unknown command: not-a-command/);
	});
});
