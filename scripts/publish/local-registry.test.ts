// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Run: npx tsx --test scripts/publish/local-registry.test.ts

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { localRegistryDir, resetLocalRegistry } from "./local-registry.ts";

describe("resetLocalRegistry", () => {
	let base: string;
	let root: string;

	beforeEach(async () => {
		base = await mkdtemp(join(tmpdir(), "local-registry-test-"));
		root = join(base, "repo");
		await mkdir(root);
		await writeFile(join(root, "package.json"), "{}");
	});

	afterEach(async () => {
		await rm(base, { recursive: true, force: true });
	});

	it("removes stale tarballs and metadata and leaves an empty registry dir", async () => {
		const dir = localRegistryDir(root);
		const stale = join(dir, "registry", "@aws-blocks", "core", "-");
		await mkdir(stale, { recursive: true });
		await writeFile(join(stale, "core-1.0.0.tgz"), "old");
		await writeFile(join(dir, "registry", "@aws-blocks", "core", "index.json"), "{}");

		await resetLocalRegistry(root, dir);

		assert.deepEqual(await readdir(dir), []);
		assert.ok(existsSync(join(root, "package.json")), "files beside the registry are kept");
	});

	it("creates the registry dir when it does not exist yet", async () => {
		const dir = localRegistryDir(root);
		await resetLocalRegistry(root, dir);
		assert.deepEqual(await readdir(dir), []);
	});

	for (const [label, dir] of [
		["the repo root", () => root],
		["a sibling of the repo", () => join(base, "dist-registry")],
		["a parent of the repo", () => base],
		["a subdirectory of the registry", () => join(root, "dist-registry", "registry")],
		["a path that escapes via ..", () => join(root, "dist-registry", "..", "..")],
		["a differently named dir in the repo", () => join(root, "dist")],
	] as const) {
		it(`refuses ${label} and deletes nothing`, async () => {
			await assert.rejects(resetLocalRegistry(root, dir()), /Refusing to reset local registry/);
			assert.ok(existsSync(join(root, "package.json")));
		});
	}

	it("removes only the link when dist-registry is a symlink", async () => {
		const outside = join(base, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "keep.txt"), "keep");
		await symlink(outside, localRegistryDir(root), "dir");

		await resetLocalRegistry(root, localRegistryDir(root));

		assert.ok(existsSync(join(outside, "keep.txt")), "the symlink target is untouched");
		assert.deepEqual(await readdir(localRegistryDir(root)), []);
	});
});
