// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/generate-dependency-changeset.ts. Same approach as
// changeset-guard.test.mjs: every case builds a throwaway git repo in a temp
// dir, copies the real generator into its scripts/ (it roots itself at
// `import.meta.dirname/..`), commits a base, commits the bump on top and runs
// the generator for real against the base commit.
//
// Run: node --test scripts/generate-dependency-changeset.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const GENERATOR_SRC = join(import.meta.dirname, "generate-dependency-changeset.ts");

const UMBRELLA = "@aws-blocks/blocks";
const SIBLING = "@aws-blocks/core";
// Published, but not re-exported by the umbrella.
const CREATE_APP = "@aws-blocks/create-blocks-app";

const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "Generator Test",
	GIT_AUTHOR_EMAIL: "generator@test.invalid",
	GIT_COMMITTER_NAME: "Generator Test",
	GIT_COMMITTER_EMAIL: "generator@test.invalid",
};

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" });
}

function write(dir, relPath, contents) {
	const full = join(dir, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, contents);
}

function pkgJson(name, extra = {}) {
	return `${JSON.stringify({ name, version: "0.1.0", ...extra }, null, 2)}\n`;
}

function changeset(entries) {
	const lines = Object.entries(entries).map(([pkg, bump]) => `"${pkg}": ${bump}`);
	return `---\n${lines.join("\n")}\n---\n\nA change.\n`;
}

/** A fixture repo with a committed base; returns the dir and the base commit. */
function baseRepo(t, files = {}) {
	const dir = mkdtempSync(join(tmpdir(), "dependency-changeset-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	mkdirSync(join(dir, "scripts"), { recursive: true });
	copyFileSync(GENERATOR_SRC, join(dir, "scripts", "generate-dependency-changeset.ts"));

	const layout = {
		"packages/blocks/package.json": pkgJson(UMBRELLA, { dependencies: { [SIBLING]: "^0.1.0" } }),
		"packages/core/package.json": pkgJson(SIBLING),
		"packages/create-blocks-app/package.json": pkgJson(CREATE_APP),
		"packages/create-blocks-app/templates/react/package.json": pkgJson("template-react"),
		"packages/create-blocks-app/templates/amplify/aws-blocks/package.json": pkgJson("template-amplify"),
		"packages/internal-tool/package.json": pkgJson("@aws-blocks/internal-tool", { private: true }),
		"test-apps/comprehensive/package.json": pkgJson("bb-test-comprehensive"),
		".changeset/README.md": "# Changesets\n",
		...files,
	};
	for (const [relPath, contents] of Object.entries(layout)) write(dir, relPath, contents);

	git(dir, "init", "-q", "-b", "main");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "base");
	return { dir, base: git(dir, "rev-parse", "HEAD").trim() };
}

function commitBump(dir, files) {
	for (const [relPath, contents] of Object.entries(files)) write(dir, relPath, contents);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "bump");
}

function generate(dir, base) {
	return execFileSync(
		process.execPath,
		["--experimental-strip-types", join(dir, "scripts", "generate-dependency-changeset.ts"), base, "automated"],
		{ cwd: dir, env: GIT_ENV, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
	);
}

/** The changesets the generator wrote, as { file: entries } with entries like `"@aws-blocks/core": patch`. */
function written(dir) {
	const out = {};
	for (const file of readdirSync(join(dir, ".changeset"))) {
		if (!file.startsWith("dependency-bump-")) continue;
		const frontmatter = readFileSync(join(dir, ".changeset", file), "utf-8").match(/^---\n([\s\S]*?)\n---/)[1];
		out[file] = frontmatter.split("\n");
	}
	return out;
}

const bumped = (name, extra = {}) => pkgJson(name, { dependencies: { "aws-cdk-lib": "^2.1.0" }, ...extra });

describe("generate-dependency-changeset", () => {
	it("patches a bumped sibling and the umbrella that re-exports it", (t) => {
		const { dir, base } = baseRepo(t);
		commitBump(dir, { "packages/core/package.json": bumped(SIBLING) });

		generate(dir, base);
		assert.deepEqual(Object.values(written(dir)), [[`"${UMBRELLA}": patch`, `"${SIBLING}": patch`]]);
	});

	it("patches create-blocks-app for a template-only bump", (t) => {
		const { dir, base } = baseRepo(t);
		commitBump(dir, { "packages/create-blocks-app/templates/react/package.json": bumped("template-react") });

		generate(dir, base);
		assert.deepEqual(Object.values(written(dir)), [[`"${CREATE_APP}": patch`]]);
	});

	it("patches create-blocks-app for a nested template manifest", (t) => {
		const { dir, base } = baseRepo(t);
		commitBump(dir, {
			"packages/create-blocks-app/templates/amplify/aws-blocks/package.json": bumped("template-amplify"),
		});

		generate(dir, base);
		assert.deepEqual(Object.values(written(dir)), [[`"${CREATE_APP}": patch`]]);
	});

	it("writes nothing when only test apps and private packages changed", (t) => {
		const { dir, base } = baseRepo(t);
		commitBump(dir, {
			"test-apps/comprehensive/package.json": bumped("bb-test-comprehensive"),
			"packages/internal-tool/package.json": bumped("@aws-blocks/internal-tool", { private: true }),
		});

		assert.match(generate(dir, base), /No published packages changed/);
		assert.deepEqual(written(dir), {});
	});

	it("writes nothing for a source change: those PRs bring their own changeset", (t) => {
		const { dir, base } = baseRepo(t);
		commitBump(dir, { "packages/core/src/index.ts": "export const a = 1;\n" });

		generate(dir, base);
		assert.deepEqual(written(dir), {});
	});

	it("leaves out packages a pending changeset covers already", (t) => {
		const { dir, base } = baseRepo(t);
		commitBump(dir, {
			"packages/core/package.json": bumped(SIBLING),
			"packages/create-blocks-app/templates/react/package.json": bumped("template-react"),
			".changeset/feature.md": changeset({ [SIBLING]: "minor", [UMBRELLA]: "patch" }),
		});

		generate(dir, base);
		assert.deepEqual(Object.values(written(dir)), [[`"${CREATE_APP}": patch`]]);
	});

	it("writes nothing when every changed package is covered", (t) => {
		const { dir, base } = baseRepo(t);
		commitBump(dir, {
			"packages/core/package.json": bumped(SIBLING),
			".changeset/feature.md": changeset({ [SIBLING]: "patch", [UMBRELLA]: "patch" }),
		});

		assert.match(generate(dir, base), /covered by changesets already/);
		assert.deepEqual(written(dir), {});
	});

	it("never overwrites a dependency changeset already on disk", (t) => {
		const { dir, base } = baseRepo(t);
		const date = new Date().toISOString().slice(0, 10);
		const existing = changeset({ [CREATE_APP]: "patch" });
		commitBump(dir, {
			"packages/core/package.json": bumped(SIBLING),
			[`.changeset/dependency-bump-${date}.md`]: existing,
		});

		generate(dir, base);
		assert.equal(readFileSync(join(dir, ".changeset", `dependency-bump-${date}.md`), "utf-8"), existing);
		assert.deepEqual(written(dir)[`dependency-bump-${date}-2.md`], [`"${UMBRELLA}": patch`, `"${SIBLING}": patch`]);
	});
});
