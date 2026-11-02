// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/sync-template-versions.ts. Each case builds a small
// fake repo in a temp dir (packages/, create-blocks-app templates, .changeset/),
// copies the real script into its scripts/ (it roots itself at
// `import.meta.dirname/..`) and runs it for real.
//
// Run: node --test scripts/sync-template-versions.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

const SCRIPT_SRC = join(import.meta.dirname, "sync-template-versions.ts");
const CHANGESET = ".changeset/create-blocks-app-template-ranges.md";

let root;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

function write(relPath, contents) {
	const path = join(root, relPath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
}

const read = (relPath) => readFileSync(join(root, relPath), "utf-8");

/** A repo with blocks 0.9.0, hosting 0.5.0, kv-store 1.2.0 and two templates. */
function setup({ ranges = "*" } = {}) {
	root = mkdtempSync(join(tmpdir(), "sync-template-versions-"));
	mkdirSync(join(root, "scripts"));
	copyFileSync(SCRIPT_SRC, join(root, "scripts", "sync-template-versions.ts"));
	write(".changeset/README.md", "# Changesets\n");
	write("packages/blocks/package.json", { name: "@aws-blocks/blocks", version: "0.9.0" });
	write("packages/hosting/package.json", { name: "@aws-blocks/hosting", version: "0.5.0" });
	write("packages/bb-kv-store/package.json", { name: "@aws-blocks/bb-kv-store", version: "1.2.0" });
	write("packages/create-blocks-app/package.json", { name: "@aws-blocks/create-blocks-app", version: "0.4.0" });
	write("packages/private-tool/package.json", { name: "@aws-blocks/private-tool", version: "0.0.0", private: true });
	const range = (version) => (ranges === "*" ? "*" : `^${version}`);
	// Hand-formatted, with a \u escape, to check the rewrite leaves the rest of the file alone.
	write(
		"packages/create-blocks-app/templates/default/package.json",
		`{\n  "name": "default",\n  "description": "Default \\u2014 web app",\n  "dependencies": {\n    "@aws-blocks/blocks": "${range("0.9.0")}",\n    "@aws-blocks/hosting": "${range("0.5.0")}",\n    "zod": "^4.0.0"\n  }\n}\n`,
	);
	write("packages/create-blocks-app/templates/amplify/aws-blocks/package.json", {
		name: "amplify-overlay",
		dependencies: { "@aws-blocks/blocks": range("0.9.0"), "@aws-blocks/bb-kv-store": range("1.2.0") },
	});
}

function run(...args) {
	const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", "scripts/sync-template-versions.ts", ...args], {
		cwd: root,
		encoding: "utf-8",
	});
	return { status: r.status, out: r.stdout + r.stderr };
}

const changeset = (name, body) => write(`.changeset/${name}.md`, `---\n${body}\n---\n\nA change.\n`);

describe("--check / --write", () => {
	it("--check fails on a '*' range and names the file, package and expected range", () => {
		setup();
		const r = run("--check");
		assert.equal(r.status, 1);
		assert.match(r.out, /templates\/default\/package\.json: @aws-blocks\/blocks is "\*", expected "\^0\.9\.0"/);
		assert.match(r.out, /templates\/amplify\/aws-blocks\/package\.json: @aws-blocks\/bb-kv-store is "\*", expected "\^1\.2\.0"/);
	});

	it("--write sets every range, nested templates included, and then --check passes", () => {
		setup();
		assert.equal(run("--write").status, 0);
		assert.deepEqual(JSON.parse(read("packages/create-blocks-app/templates/amplify/aws-blocks/package.json")).dependencies, {
			"@aws-blocks/blocks": "^0.9.0",
			"@aws-blocks/bb-kv-store": "^1.2.0",
		});
		assert.equal(run("--check").status, 0);
	});

	it("--write changes only the ranges, leaving escapes, formatting and other deps as they were", () => {
		setup();
		const before = read("packages/create-blocks-app/templates/default/package.json");
		run("--write");
		const expected = before.replace('"@aws-blocks/blocks": "*"', '"@aws-blocks/blocks": "^0.9.0"').replace('"@aws-blocks/hosting": "*"', '"@aws-blocks/hosting": "^0.5.0"');
		assert.equal(read("packages/create-blocks-app/templates/default/package.json"), expected);
	});

	it("--write follows a version bump", () => {
		setup({ ranges: "caret" });
		write("packages/blocks/package.json", { name: "@aws-blocks/blocks", version: "0.10.0" });
		assert.equal(run("--check").status, 1);
		run("--write");
		assert.match(read("packages/create-blocks-app/templates/default/package.json"), /"@aws-blocks\/blocks": "\^0\.10\.0"/);
	});

	it("fails when a template depends on a package that isn't published from packages/", () => {
		setup({ ranges: "caret" });
		write("packages/create-blocks-app/templates/sql/package.json", { dependencies: { "@aws-blocks/private-tool": "*" } });
		assert.equal(run("--check").status, 1);
		const r = run("--write");
		assert.notEqual(r.status, 0);
		assert.match(r.out, /@aws-blocks\/private-tool is not a published package/);
	});
});

describe("--changeset", () => {
	it("writes a create-blocks-app patch changeset when a 0.x minor leaves the template range", () => {
		setup({ ranges: "caret" });
		changeset("blocks-minor", '"@aws-blocks/blocks": minor');
		assert.equal(run("--changeset").status, 0);
		const written = read(CHANGESET);
		assert.match(written, /^---\n"@aws-blocks\/create-blocks-app": patch\n---\n/);
		assert.match(written, /`@aws-blocks\/blocks@0\.10\.0`/);
	});

	it("writes one for a major on a 1.x package, and lists every package that moved", () => {
		setup({ ranges: "caret" });
		changeset("kv-major", '"@aws-blocks/bb-kv-store": major\n"@aws-blocks/hosting": minor');
		run("--changeset");
		const written = read(CHANGESET);
		assert.match(written, /`@aws-blocks\/bb-kv-store@2\.0\.0`/);
		assert.match(written, /`@aws-blocks\/hosting@0\.6\.0`/);
	});

	it("takes the highest bump across changesets", () => {
		setup({ ranges: "caret" });
		changeset("a", '"@aws-blocks/blocks": patch');
		changeset("b", "'@aws-blocks/blocks': minor");
		run("--changeset");
		assert.match(read(CHANGESET), /`@aws-blocks\/blocks@0\.10\.0`/);
	});

	it("writes nothing when the new versions stay inside the template ranges", () => {
		setup({ ranges: "caret" });
		changeset("patches", '"@aws-blocks/blocks": patch\n"@aws-blocks/bb-kv-store": minor');
		assert.equal(run("--changeset").status, 0);
		assert.equal(existsSync(join(root, CHANGESET)), false);
	});

	it("writes nothing when create-blocks-app already releases", () => {
		setup({ ranges: "caret" });
		changeset("both", '"@aws-blocks/blocks": minor\n"@aws-blocks/create-blocks-app": patch');
		run("--changeset");
		assert.equal(existsSync(join(root, CHANGESET)), false);
	});

	it("treats a leftover '*' range as moved, so the first stamped templates get released", () => {
		setup();
		changeset("blocks-patch", '"@aws-blocks/blocks": patch');
		run("--changeset");
		assert.match(read(CHANGESET), /`@aws-blocks\/blocks@0\.9\.1`/);
	});

	it("writes nothing in pre-release mode", () => {
		setup({ ranges: "caret" });
		changeset("blocks-minor", '"@aws-blocks/blocks": minor');
		write(".changeset/pre.json", { mode: "pre", tag: "next" });
		assert.equal(run("--changeset").status, 0);
		assert.equal(existsSync(join(root, CHANGESET)), false);
	});
});
