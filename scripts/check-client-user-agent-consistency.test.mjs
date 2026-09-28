// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/check-client-user-agent-consistency.ts. Every case builds
// a throwaway repo in a temp dir and copies the real guard into its scripts/ (the
// guard roots itself at `__dirname/..`, so the copy sees the fixture as the repo),
// then runs the guard for real: real fs, no stubs.
//
// Run: node --test scripts/check-client-user-agent-consistency.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPTS_DIR = import.meta.dirname;
const GUARD_NAME = "check-client-user-agent-consistency.ts";
const GUARD_SRC = join(SCRIPTS_DIR, GUARD_NAME);
const REPO_ROOT = join(SCRIPTS_DIR, "..");

/** Builds a fixture repo whose packages/ holds the given bb-* source files. */
function withFixture(files, run) {
	const dir = mkdtempSync(join(tmpdir(), "cua-guard-"));
	try {
		mkdirSync(join(dir, "scripts"), { recursive: true });
		copyFileSync(GUARD_SRC, join(dir, "scripts", GUARD_NAME));
		for (const [rel, content] of Object.entries(files)) {
			const abs = join(dir, "packages", rel);
			mkdirSync(join(abs, ".."), { recursive: true });
			writeFileSync(abs, content);
		}
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Runs the copied guard against its fixture, returning exit code and output. */
function runGuard(dir) {
	try {
		const stdout = execFileSync("npx", ["tsx", join(dir, "scripts", GUARD_NAME)], {
			cwd: REPO_ROOT,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, output: stdout };
	} catch (err) {
		return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

const INSTALLED = `import { installClientUserAgent } from '@aws-blocks/core';
const client = new DynamoDBClient({ customUserAgent: this.buildUserAgentChain() });
installClientUserAgent(client);
`;

const MISSING = `const client = new DynamoDBClient({ customUserAgent: this.buildUserAgentChain() });
`;

// Built through `new (await import(...)).XClient(`, which the bare constructor
// pattern misses.
const DYNAMIC_MISSING = `const c = new (await import('@aws-sdk/client-bedrock')).BedrockClient({ customUserAgent });
`;

describe("check-client-user-agent-consistency", () => {
	it("passes when every customUserAgent site installs the middleware", () => {
		withFixture({ "bb-kv-store/src/index.aws.ts": INSTALLED }, (dir) => {
			const { code, output } = runGuard(dir);
			assert.equal(code, 0, output);
			assert.match(output, /All 1 customUserAgent site\(s\)/);
		});
	});

	it("fails when a customUserAgent site omits the install call", () => {
		withFixture({ "bb-kv-store/src/index.aws.ts": MISSING }, (dir) => {
			const { code, output } = runGuard(dir);
			assert.equal(code, 1);
			assert.match(output, /1 customUserAgent site\(s\) but only 0/);
		});
	});

	it("fails when it finds no sites to check, so a silent no-op cannot pass", () => {
		withFixture({ "bb-kv-store/src/index.aws.ts": "export const noop = 1;\n" }, (dir) => {
			const { code, output } = runGuard(dir);
			assert.equal(code, 1);
			assert.match(output, /found no Building Block client-construction sites/);
		});
	});

	it("catches a dynamically imported client that omits the install call", () => {
		withFixture({ "bb-agent/src/model-factory.ts": DYNAMIC_MISSING }, (dir) => {
			const { code, output } = runGuard(dir);
			assert.equal(code, 1);
			assert.match(output, /1 customUserAgent site\(s\) but only 0/);
		});
	});

	it("counts each customUserAgent site in a file with two clients", () => {
		withFixture({ "bb-kv-store/src/index.aws.ts": INSTALLED + MISSING }, (dir) => {
			const { code, output } = runGuard(dir);
			assert.equal(code, 1);
			assert.match(output, /2 customUserAgent site\(s\) but only 1/);
		});
	});
});
