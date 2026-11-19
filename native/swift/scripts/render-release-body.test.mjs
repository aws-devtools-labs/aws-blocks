// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for native/swift/scripts/render-release-body.sh. The script reads
// the changelog entry from stdin and renders a release-PR body for one of two
// templates. These tests run the real script (real bash, no stubs), feeding the
// entry on stdin exactly as the workflow does.
//
// Run: node --test native/swift/scripts/render-release-body.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "render-release-body.sh");

/**
 * Runs the script with the given template + version, piping `entry` to stdin.
 * Returns exit status plus combined stdout+stderr. A non-zero exit is under
 * test in some cases, so the throw execFileSync raises is unwrapped.
 */
function render(template, version, entry = "") {
	try {
		const stdout = execFileSync(SCRIPT, [template, version], {
			input: entry,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { status: 0, output: stdout };
	} catch (err) {
		return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

describe("render-release-body", () => {
	it("monorepo template substitutes version and entry", () => {
		const { status, output } = render("monorepo", "1.2.3", "- Added a thing.\n- Fixed a bug.");
		assert.equal(status, 0, output);
		assert.match(output, /## Swift SDK Release 1\.2\.3/);
		assert.match(output, /- Added a thing\./);
		assert.match(output, /- Fixed a bug\./);
		assert.match(output, /tagged `swift@1\.2\.3`/);
		assert.match(output, /Approve the workflow runs/);
		assert.match(output, /"Sync release from aws-blocks" workflow in cdk-blocks-swift with version `1\.2\.3`/);
		assert.match(output, /github\.com\/aws\/cdk-blocks-swift\/actions\/workflows\/sync-from-monorepo\.yml/);
		assert.doesNotMatch(output, /__VERSION__|__CHANGELOG_ENTRY__/);
	});

	it("target template renders its distinct body", () => {
		const { status, output } = render("target", "1.2.3", "- Some change.");
		assert.equal(status, 0, output);
		assert.match(output, /## Release 1\.2\.3/);
		assert.match(output, /cdk-blocks tag `swift@1\.2\.3`/);
		assert.match(output, /- Some change\./);
		assert.doesNotMatch(output, /## Swift SDK Release/);
		assert.doesNotMatch(output, /__VERSION__|__CHANGELOG_ENTRY__/);
	});

	it("keeps a hostile entry literal (no expansion, no truncation)", () => {
		// Every one of these would misbehave if the entry were interpolated into
		// the script text or substituted unquoted: `&` is patsub-special under
		// bash 5.2, `$(...)`/backticks are command substitution, and a bare EOF
		// line would terminate a heredoc early.
		const entry = [
			"A & B",
			"a=1&b=2",
			"\\&",
			"a `id` span",
			"$(id)",
			"EOF",
			"trailing text",
		].join("\n");

		const { status, output } = render("monorepo", "9.9.9", entry);
		assert.equal(status, 0, output);
		assert.match(output, /a=1&b=2/);
		assert.ok(output.includes("$(id)"), `expected literal $(id) in:\n${output}`);
		assert.match(output, /^EOF$/m);
		assert.match(output, /a `id` span/);
		assert.match(output, /trailing text/);
		assert.doesNotMatch(output, /__CHANGELOG_ENTRY__/);
	});

	for (const [template, url] of [
		["monorepo", "github.com/aws/cdk-blocks/blob/release/swift-1.2.3/native/swift/CHANGELOG.md"],
		["target", "github.com/aws/cdk-blocks/blob/swift@1.2.3/native/swift/CHANGELOG.md"],
	]) {
		it(`${template} template links to the CHANGELOG when the entry is too long`, () => {
			const entry = `- ${"x".repeat(70000)}`;
			const { status, output } = render(template, "1.2.3", entry);
			assert.equal(status, 0, output.slice(0, 500));
			assert.ok(output.length < 60000, `body is ${output.length} characters`);
			assert.ok(!output.includes("xxxxxxxxxx"), "the long entry should be dropped");
			assert.ok(output.includes(url), `expected a link to ${url}`);
			assert.doesNotMatch(output, /__VERSION__|__CHANGELOG_ENTRY__/);
		});
	}

	it("keeps an entry that fits", () => {
		const entry = `- ${"y".repeat(50000)}`;
		const { status, output } = render("target", "1.2.3", entry);
		assert.equal(status, 0);
		assert.ok(output.includes(entry), "the entry should be kept");
	});

	it("rejects an unknown template name", () => {
		const { status, output } = render("bogus", "1.2.3", "entry");
		assert.notEqual(status, 0, output);
		assert.match(output, /unknown template "bogus"/);
	});

	it("fails when the version arg is missing", () => {
		const { status, output } = render("monorepo", "", "entry");
		assert.notEqual(status, 0, output);
		assert.match(output, /Usage/);
	});
});
