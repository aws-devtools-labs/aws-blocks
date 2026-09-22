// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/changeset-guard.ts. Every case builds a throwaway git
// repo in a temp dir, copies the real guard into its scripts/ (the guard roots
// itself at `import.meta.dirname/..`, so the copy sees the fixture as the repo),
// commits a base, points refs/remotes/origin/main at it, then commits the "PR"
// changes on top and runs the guard for real: real git, real fs, no stubs.
//
// Run: node --test scripts/changeset-guard.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const SCRIPTS_DIR = import.meta.dirname;
const GUARD_SRC = join(SCRIPTS_DIR, "changeset-guard.ts");
const REPO_ROOT = join(SCRIPTS_DIR, "..");

const UMBRELLA = "@aws-blocks/blocks";
const SIBLING = "@aws-blocks/core";
const OTHER_SIBLING = "@aws-blocks/bb-kv-store";
// In the workspace but not re-exported by the umbrella, so releasing it alone
// must never trigger the umbrella requirement.
const NON_SIBLING = "@aws-blocks/create-blocks-app";

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

function pkgJson(name, extra = {}) {
	return `${JSON.stringify({ name, version: "0.1.0", ...extra }, null, 2)}\n`;
}

/** `---\n<entries>\n---\n\n<body>` frontmatter, the shape `npx changeset` writes. */
function changeset(entries, body = "A change.") {
	const lines = Object.entries(entries).map(([pkg, bump]) => `"${pkg}": ${bump}`);
	return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

/**
 * A fixture repo whose base commit is what origin/main points at. `files` is
 * merged over the default workspace layout before that base commit is made.
 */
function baseRepo(t, files = {}) {
	const dir = mkdtempSync(join(tmpdir(), "changeset-guard-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	mkdirSync(join(dir, "scripts"), { recursive: true });
	copyFileSync(GUARD_SRC, join(dir, "scripts", "changeset-guard.ts"));

	const workspaces = [
		"packages/blocks",
		"packages/core",
		"packages/bb-kv-store",
		"packages/create-blocks-app",
	];
	const layout = {
		"package.json": `${JSON.stringify({ name: "fixture-root", private: true, workspaces }, null, 2)}\n`,
		"packages/blocks/package.json": pkgJson(UMBRELLA, {
			dependencies: {
				[SIBLING]: "^0.1.0",
				[OTHER_SIBLING]: "^0.1.0",
				"aws-cdk-lib": "^2.0.0",
			},
		}),
		"packages/core/package.json": pkgJson(SIBLING),
		"packages/bb-kv-store/package.json": pkgJson(OTHER_SIBLING),
		"packages/create-blocks-app/package.json": pkgJson(NON_SIBLING),
		".changeset/config.json": `${JSON.stringify({ changelog: "@changesets/cli/changelog" }, null, 2)}\n`,
		".changeset/README.md": "# Changesets\n",
		...files,
	};

	for (const [relPath, contents] of Object.entries(layout)) {
		if (contents === null) continue;
		write(dir, relPath, contents);
	}

	git(dir, "init", "-q", "-b", "main");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "base");
	git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
	return dir;
}

/** Applies the PR's changes on top of the base and commits them. `null` deletes. */
function commitPr(dir, files) {
	for (const [relPath, contents] of Object.entries(files)) {
		if (contents === null) {
			rmSync(join(dir, relPath), { force: true });
			continue;
		}
		write(dir, relPath, contents);
	}
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "pr");
}

/**
 * Runs the guard in the fixture and returns its exit code plus combined
 * stdout+stderr. A non-zero exit is the behaviour under test, so the throw
 * execFileSync raises for it is unwrapped rather than propagated.
 */
function guard(dir, command, env = {}) {
	try {
		const stdout = execFileSync(
			process.execPath,
			["--experimental-strip-types", join(dir, "scripts", "changeset-guard.ts"), command],
			{
				cwd: dir,
				env: { ...GIT_ENV, ...env },
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		return { status: 0, output: stdout };
	} catch (err) {
		return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

describe("verify-umbrella: a sibling release needs the umbrella entry", () => {
	it("fails when this PR releases a re-exported sibling and nothing bumps the umbrella", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, { ".changeset/ship-core.md": changeset({ [SIBLING]: "patch" }) });

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 1, output);
		assert.match(output, /releases package\(s\) that @aws-blocks\/blocks re-exports/);
		assert.match(output, /@aws-blocks\/core/);
	});

	it("passes when the same changeset bumps the umbrella too", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, {
			".changeset/ship-core.md": changeset({ [SIBLING]: "patch", [UMBRELLA]: "patch" }),
		});

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 0, output);
		assert.match(output, /is bumped alongside them/);
	});

	it("passes when a changeset already pending on main bumps the umbrella", (t) => {
		const dir = baseRepo(t, {
			".changeset/pending-umbrella.md": changeset({ [UMBRELLA]: "patch" }),
		});
		commitPr(dir, { ".changeset/ship-core.md": changeset({ [SIBLING]: "patch" }) });

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 0, output);
	});

	it("passes when the PR releases only a package the umbrella does not re-export", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, { ".changeset/cli.md": changeset({ [NON_SIBLING]: "patch" }) });

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 0, output);
		assert.match(output, /No changeset here releases/);
	});

	it("does not fail an unrelated PR for a sibling release someone else left pending", (t) => {
		const dir = baseRepo(t, {
			".changeset/someone-elses-core.md": changeset({ [SIBLING]: "patch" }),
		});
		commitPr(dir, { "README.md": "# fixture\n" });

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 0, output);
	});
});

describe("verify-umbrella: withdrawing the umbrella entry", () => {
	it("fails when the PR deletes the only changeset that bumped the umbrella", (t) => {
		const dir = baseRepo(t, {
			".changeset/pending-core.md": changeset({ [SIBLING]: "patch" }),
			".changeset/pending-umbrella.md": changeset({ [UMBRELLA]: "patch" }),
		});
		commitPr(dir, { ".changeset/pending-umbrella.md": null });

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 1, output);
		assert.match(output, /removes the @aws-blocks\/blocks entry from/);
		assert.match(output, /\.changeset\/pending-umbrella\.md/);
		assert.match(output, /@aws-blocks\/core/);
	});

	it("fails when the PR strips the umbrella line out of an existing changeset", (t) => {
		const dir = baseRepo(t, {
			".changeset/pending-core.md": changeset({ [SIBLING]: "patch" }),
			".changeset/pending-cli.md": changeset({ [NON_SIBLING]: "patch", [UMBRELLA]: "patch" }),
		});
		commitPr(dir, {
			".changeset/pending-cli.md": changeset({ [NON_SIBLING]: "patch" }),
		});

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 1, output);
		assert.match(output, /removes the @aws-blocks\/blocks entry from/);
		assert.match(output, /\.changeset\/pending-cli\.md/);
	});

	it("fails when the withdrawn changeset also released a sibling of its own", (t) => {
		const dir = baseRepo(t, {
			".changeset/core-and-umbrella.md": changeset({
				[SIBLING]: "patch",
				[UMBRELLA]: "patch",
			}),
		});
		commitPr(dir, {
			".changeset/core-and-umbrella.md": changeset({ [SIBLING]: "patch" }),
		});

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 1, output);
	});

	it("passes when the withdrawal leaves no sibling release pending (a revert)", (t) => {
		const dir = baseRepo(t, {
			".changeset/core-and-umbrella.md": changeset({
				[SIBLING]: "patch",
				[UMBRELLA]: "patch",
			}),
		});
		commitPr(dir, { ".changeset/core-and-umbrella.md": null });

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 0, output);
		assert.match(output, /No changeset here releases/);
	});

	it("passes when the umbrella entry moves to another changeset", (t) => {
		const dir = baseRepo(t, {
			".changeset/pending-core.md": changeset({ [SIBLING]: "patch" }),
			".changeset/pending-umbrella.md": changeset({ [UMBRELLA]: "patch" }),
		});
		commitPr(dir, {
			".changeset/pending-umbrella.md": null,
			".changeset/consolidated.md": changeset({ [SIBLING]: "patch", [UMBRELLA]: "patch" }),
		});

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 0, output);
	});

	it("passes for the release PR, which consumes every changeset at once", (t) => {
		const dir = baseRepo(t, {
			".changeset/pending-core.md": changeset({ [SIBLING]: "patch" }),
			".changeset/pending-umbrella.md": changeset({ [UMBRELLA]: "patch" }),
		});
		commitPr(dir, {
			".changeset/pending-core.md": null,
			".changeset/pending-umbrella.md": null,
			"packages/core/package.json": pkgJson(SIBLING, { version: "0.1.1" }),
		});

		const { status, output } = guard(dir, "verify-umbrella", {
			PR_TITLE: "chore: version packages",
		});
		assert.equal(status, 0, output);
	});

	it("ignores nested .changeset subdirectories, which changesets never reads", (t) => {
		const dir = baseRepo(t, {
			".changeset/pending-core.md": changeset({ [SIBLING]: "patch" }),
			".changeset/archive/old.md": changeset({ [UMBRELLA]: "patch" }),
			".changeset/pending-umbrella.md": changeset({ [UMBRELLA]: "patch" }),
		});
		commitPr(dir, { ".changeset/archive/old.md": null });

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 0, output);
		assert.doesNotMatch(output, /archive/);
	});

	it("copes with a merge base that has no .changeset directory at all", (t) => {
		// Nothing can have been withdrawn from a directory that did not exist, so
		// the missing base listing must not read as a git failure.
		const dir = baseRepo(t, {
			".changeset/config.json": null,
			".changeset/README.md": null,
		});
		commitPr(dir, { ".changeset/ship-core.md": changeset({ [SIBLING]: "patch" }) });

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 1, output);
		assert.match(output, /releases package\(s\) that @aws-blocks\/blocks re-exports/);
		assert.doesNotMatch(output, /fatal|ENOENT/);
	});
});

describe("verify-umbrella: fails loudly instead of asserting nothing", () => {
	it("fails when the umbrella package.json cannot be parsed", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, {
			".changeset/ship-core.md": changeset({ [SIBLING]: "patch" }),
			"packages/blocks/package.json": '{ "name": "@aws-blocks/blocks", oops\n',
		});

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 1, output);
		assert.match(output, /Cannot parse @aws-blocks\/blocks's package\.json/);
		assert.doesNotMatch(output, /No changeset here releases/);
	});

	it("fails when the umbrella package.json is missing", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, {
			".changeset/ship-core.md": changeset({ [SIBLING]: "patch" }),
			"packages/blocks/package.json": null,
		});

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 1, output);
		assert.match(output, /Cannot read @aws-blocks\/blocks's package\.json/);
	});

	it("fails when the umbrella declares no @aws-blocks/* dependencies", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, {
			".changeset/ship-core.md": changeset({ [SIBLING]: "patch" }),
			"packages/blocks/package.json": pkgJson(UMBRELLA, {
				dependencies: { "aws-cdk-lib": "^2.0.0" },
			}),
		});

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 1, output);
		assert.match(output, /declares no @aws-blocks\/\* dependencies/);
	});

	it("fails when the umbrella has no dependencies block at all", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, {
			".changeset/ship-core.md": changeset({ [SIBLING]: "patch" }),
			"packages/blocks/package.json": pkgJson(UMBRELLA),
		});

		const { status, output } = guard(dir, "verify-umbrella");
		assert.equal(status, 1, output);
		assert.match(output, /has no "dependencies" object/);
	});
});

describe("verify-coverage", () => {
	it("fails when a changed package has no changeset entry", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, { "packages/core/src/index.ts": "export const a = 1;\n" });

		const { status, output } = guard(dir, "verify-coverage");
		assert.equal(status, 1, output);
		assert.match(output, /@aws-blocks\/core/);
	});

	it("passes when every changed package is covered", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, {
			"packages/core/src/index.ts": "export const a = 1;\n",
			".changeset/ship-core.md": changeset({ [SIBLING]: "patch", [UMBRELLA]: "patch" }),
		});

		const { status, output } = guard(dir, "verify-coverage");
		assert.equal(status, 0, output);
		assert.match(output, /are covered by changesets/);
	});

	it("skips the release PR, which has consumed its changesets already", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, { "packages/core/package.json": pkgJson(SIBLING, { version: "0.1.1" }) });

		const { status, output } = guard(dir, "verify-coverage", {
			PR_TITLE: "chore: version packages",
		});
		assert.equal(status, 0, output);
		assert.match(output, /Skipping coverage check for the release PR/);
	});

	it("fails loudly when a changed package's package.json cannot be parsed", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, { "packages/core/package.json": "{ not json\n" });

		const { status, output } = guard(dir, "verify-coverage");
		assert.equal(status, 1, output);
		assert.match(output, /Cannot parse packages\/core\/package\.json/);
		assert.doesNotMatch(output, /No publishable packages were changed/);
	});
});

describe("block-major", () => {
	it("fails on a major bump", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, { ".changeset/big.md": changeset({ [SIBLING]: "major" }) });

		const { status, output } = guard(dir, "block-major");
		assert.equal(status, 1, output);
		assert.match(output, /Major version bumps are not allowed/);
	});

	it("passes on minor and patch bumps", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, {
			".changeset/breaking.md": changeset({ [SIBLING]: "minor", [UMBRELLA]: "patch" }),
		});

		const { status, output } = guard(dir, "block-major");
		assert.equal(status, 0, output);
	});
});

describe("validate-structure", () => {
	it("passes on well-formed changesets, including an empty one", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, {
			".changeset/ok.md": changeset({ [SIBLING]: "patch", [UMBRELLA]: "patch" }),
			// What `changeset --empty` writes: no entries, so the frontmatter body is
			// a single blank line.
			".changeset/empty.md": changeset({}, "Empty changeset."),
		});

		const { status, output } = guard(dir, "validate-structure");
		assert.equal(status, 0, output);
	});

	it("fails on a package name that is not in the workspace", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, { ".changeset/typo.md": changeset({ "@aws-blocks/kv-store": "patch" }) });

		const { status, output } = guard(dir, "validate-structure");
		assert.equal(status, 1, output);
		assert.match(output, /unknown package "@aws-blocks\/kv-store"/);
	});

	it("fails on an invalid bump type", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, { ".changeset/bad-bump.md": changeset({ [SIBLING]: "pathc" }) });

		const { status, output } = guard(dir, "validate-structure");
		assert.equal(status, 1, output);
		assert.match(output, /invalid bump "pathc"/);
	});

	it("fails on broken frontmatter", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, { ".changeset/no-frontmatter.md": `"${SIBLING}": patch\n` });

		const { status, output } = guard(dir, "validate-structure");
		assert.equal(status, 1, output);
		assert.match(output, /missing or malformed frontmatter/);
	});

	it("fails loudly when a workspace member's package.json cannot be parsed", (t) => {
		// Silently skipping it shrinks the set of legitimate package names, which
		// used to surface as a bogus "unknown package" error for every entry.
		const dir = baseRepo(t);
		commitPr(dir, {
			".changeset/ok.md": changeset({ [SIBLING]: "patch", [UMBRELLA]: "patch" }),
			"packages/core/package.json": "{ not json\n",
		});

		const { status, output } = guard(dir, "validate-structure");
		assert.equal(status, 1, output);
		assert.match(output, /Cannot parse packages\/core\/package\.json/);
		assert.doesNotMatch(output, /unknown package/);
	});

	it("fails loudly when the root package.json declares no workspaces", (t) => {
		const dir = baseRepo(t);
		commitPr(dir, {
			".changeset/ok.md": changeset({ [SIBLING]: "patch", [UMBRELLA]: "patch" }),
			"package.json": `${JSON.stringify({ name: "fixture-root", private: true }, null, 2)}\n`,
		});

		const { status, output } = guard(dir, "validate-structure");
		assert.equal(status, 1, output);
		assert.match(output, /no "workspaces" array/);
		assert.doesNotMatch(output, /unknown package/);
	});
});

describe("cli", () => {
	it("exits 2 on an unknown command", (t) => {
		const dir = baseRepo(t);
		const { status, output } = guard(dir, "verify-everything");
		assert.equal(status, 2, output);
		assert.match(output, /Unknown command: verify-everything/);
	});
});

describe("the real umbrella package.json", () => {
	// The fail-loud paths above are only safe to ship if the real repo satisfies
	// them, so assert the invariant they depend on against the real file.
	it("parses and declares the siblings the guard asserts against", () => {
		const raw = readFileSync(join(REPO_ROOT, "packages", "blocks", "package.json"), "utf-8");
		const deps = JSON.parse(raw).dependencies;
		assert.equal(typeof deps, "object");
		const siblings = Object.keys(deps).filter(
			(name) => name.startsWith("@aws-blocks/") && name !== UMBRELLA,
		);
		assert.ok(siblings.length > 0, "the umbrella must re-export at least one sibling");
		assert.ok(siblings.includes(SIBLING), `expected ${SIBLING} among ${siblings.join(", ")}`);
	});
});
