// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Run: npx tsx --test scripts/publish/local-registry.test.ts

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	localRegistryDir,
	resetLocalRegistry,
	resolveRegistryRequest,
	upstreamRegistryUrl,
	UPSTREAM_REGISTRY,
} from "./local-registry.ts";

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
		const stale = join(dir, "registry", "@aws-cdk-blocks", "core", "-");
		await mkdir(stale, { recursive: true });
		await writeFile(join(stale, "core-1.0.0.tgz"), "old");
		await writeFile(join(dir, "registry", "@aws-cdk-blocks", "core", "index.json"), "{}");

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

describe("resolveRegistryRequest", () => {
	let base: string;
	let registryDir: string;

	beforeEach(async () => {
		base = await mkdtemp(join(tmpdir(), "local-registry-serve-test-"));
		registryDir = join(base, "dist-registry");
		await mkdir(join(registryDir, "registry", "@aws-cdk-blocks", "core"), { recursive: true });
		await writeFile(join(registryDir, "registry", "@aws-cdk-blocks", "core", "index.json"), "{}");
		await writeFile(join(registryDir, "registry", "core-0.1.0.tgz"), "tgz");
		// A sibling whose name starts with the registry dir name.
		await mkdir(join(base, "dist-registry-extra"));
		await writeFile(join(base, "dist-registry-extra", "secret.txt"), "outside");
	});

	afterEach(async () => {
		await rm(base, { recursive: true, force: true });
	});

	it("maps a scoped metadata request to index.json inside the registry", async () => {
		const result = resolveRegistryRequest(registryDir, "/registry/@aws-cdk-blocks%2fcore");
		assert.ok(result);
		assert.deepEqual(result, {
			uri: "/registry/@aws-cdk-blocks/core/index.json",
			filePath: join(registryDir, "registry", "@aws-cdk-blocks", "core", "index.json"),
		});
		assert.equal(await readFile(result.filePath, "utf8"), "{}");
	});

	it("maps a tarball request to the file inside the registry", () => {
		const result = resolveRegistryRequest(registryDir, "/registry/core-0.1.0.tgz");
		assert.equal(result?.filePath, join(registryDir, "registry", "core-0.1.0.tgz"));
	});

	it("allows .. segments that stay inside the registry", () => {
		const result = resolveRegistryRequest(registryDir, "/registry/x/../core-0.1.0.tgz");
		assert.equal(result?.filePath, join(registryDir, "registry", "core-0.1.0.tgz"));
	});

	for (const [label, url] of [
		["a directory that shares the registry name prefix", "/../dist-registry-extra/secret.txt"],
		["the same sibling via a .tgz path", "/../dist-registry-extra/secret.tgz"],
		["the parent directory via ..", "/../../etc/passwd"],
		["the parent directory via encoded ..", "/%2e%2e%2f%2e%2e%2fetc%2fpasswd"],
		["the sibling via encoded ..", "/%2e%2e%2fdist-registry-extra%2fsecret.txt"],
	] as const) {
		it(`rejects paths outside the registry directory: ${label}`, () => {
			assert.equal(resolveRegistryRequest(registryDir, url), undefined);
		});
	}

	it("rejects a malformed percent-encoding", () => {
		assert.equal(resolveRegistryRequest(registryDir, "/%E0"), undefined);
	});
});

describe("upstreamRegistryUrl", () => {
	it("forwards a third-party package to the public registry", () => {
		assert.equal(upstreamRegistryUrl("/registry/zod"), `${UPSTREAM_REGISTRY}/zod`);
	});

	it("forwards a third-party scoped package with its encoding intact", () => {
		assert.equal(
			upstreamRegistryUrl("/registry/@types%2fnode"),
			`${UPSTREAM_REGISTRY}/@types%2fnode`,
		);
	});

	it("forwards a third-party tarball", () => {
		assert.equal(
			upstreamRegistryUrl("/registry/zod/-/zod-3.23.8.tgz"),
			`${UPSTREAM_REGISTRY}/zod/-/zod-3.23.8.tgz`,
		);
	});

	// A published copy of one of this repo's own packages must never stand in for
	// the working tree's, so a miss on these is a publish failure, not a fetch.
	for (const [label, url] of [
		["a scoped package", "/registry/@aws-cdk-blocks/core"],
		["a scoped package, encoded as npm sends it", "/registry/@aws-cdk-blocks%2fcore"],
		["a scoped tarball", "/registry/@aws-cdk-blocks/core/-/core-0.1.0.tgz"],
		["the unscoped umbrella", "/registry/aws-cdk-blocks"],
		["the unscoped umbrella's tarball", "/registry/aws-cdk-blocks/-/aws-cdk-blocks-0.1.0.tgz"],
	] as const) {
		it(`never forwards this repo's own packages: ${label}`, () => {
			assert.equal(upstreamRegistryUrl(url), undefined);
		});
	}

	it("forwards a third-party package whose name merely starts with the umbrella's", () => {
		assert.equal(
			upstreamRegistryUrl("/registry/aws-cdk-blocks-community"),
			`${UPSTREAM_REGISTRY}/aws-cdk-blocks-community`,
		);
	});

	for (const [label, url] of [
		["a path outside the registry prefix", "/other/zod"],
		["the server root", "/"],
		["an authority that would move the request to another host", "/registry//evil.example.com/zod"],
		["an encoded authority", "/registry/%2f%2fevil.example.com%2fzod"],
		// A backslash authority is why the origin is checked rather than a set of
		// forbidden characters: URL resolves `\\host` to that host, so a blocklist
		// of `/` and `..` forwarded the request off the upstream registry.
		["a backslash authority", "/registry/\\\\evil.example.com/zod"],
		["an encoded backslash authority", "/registry/%5c%5cevil.example.com%2fzod"],
		["a traversal segment", "/registry/../zod"],
		["a malformed percent-encoding", "/registry/%E0"],
	] as const) {
		it(`refuses to forward ${label}`, () => {
			assert.equal(upstreamRegistryUrl(url), undefined);
		});
	}
});
