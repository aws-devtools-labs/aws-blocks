// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the offline checks in scripts/container-default-image-digest.mjs.
// The registry calls themselves run in the `Container default image digest` workflow.
//
// Run: node --test scripts/container-default-image-digest.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertIndexMediaType,
	assertListsLinuxArm64,
	INDEX_MEDIA_TYPES,
	InvalidPinError,
	pinnedDigest,
	readPinned,
} from './container-default-image-digest.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('readPinned', () => {
	it('reads the assigned value, not a quoted string in a comment that names the constant', () => {
		const source = [
			"/** see {@link DEFAULT_CONTAINER_IMAGE} for 'x' */",
			'export const DEFAULT_CONTAINER_IMAGE =',
			`\t'public.ecr.aws/docker/library/node@${DIGEST}'; // node:24-slim`,
		].join('\n');
		assert.equal(readPinned(source), `public.ecr.aws/docker/library/node@${DIGEST}`);
	});

	it("reads the repo's current pin as a valid digest reference", () => {
		const root = join(fileURLToPath(import.meta.url), '..', '..');
		const source = readFileSync(join(root, 'packages/bb-container-compute/src/default-image.ts'), 'utf8');
		assert.match(pinnedDigest(readPinned(source)), /^sha256:[0-9a-f]{64}$/);
	});
});

describe('pinnedDigest', () => {
	it('returns the digest of a digest-only reference', () => {
		assert.equal(pinnedDigest(`public.ecr.aws/docker/library/node@${DIGEST}`), DIGEST);
	});

	for (const ref of [
		undefined,
		'public.ecr.aws/docker/library/node:24-slim',
		`public.ecr.aws/docker/library/node:24-slim@${DIGEST}`,
		`public.ecr.aws/docker/library/node@sha256:${'a'.repeat(63)}`,
		`docker.io/library/node@${DIGEST}`,
	]) {
		it(`rejects ${ref} as an invalid pin`, () => {
			assert.throws(() => pinnedDigest(ref), InvalidPinError);
		});
	}
});

describe('assertIndexMediaType', () => {
	for (const type of INDEX_MEDIA_TYPES) {
		it(`accepts ${type}, with or without parameters`, () => {
			assertIndexMediaType(type, 'x');
			assertIndexMediaType(`${type}; charset=utf-8`, 'x');
		});
	}

	for (const type of [
		'application/vnd.oci.image.manifest.v1+json',
		'application/vnd.docker.distribution.manifest.v2+json',
		'application/json',
		null,
	]) {
		it(`rejects ${type}, so a single-platform manifest digest isn't taken for the index`, () => {
			assert.throws(() => assertIndexMediaType(type, 'x'), /is not an image index/);
		});
	}
});

describe('assertListsLinuxArm64', () => {
	it('accepts an index with a linux/arm64 manifest', () => {
		assertListsLinuxArm64({
			manifests: [
				{ platform: { os: 'linux', architecture: 'amd64' } },
				{ platform: { os: 'unknown', architecture: 'unknown' } },
				{ platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } },
			],
		});
	});

	it('rejects an index without linux/arm64, naming what it lists', () => {
		assert.throws(
			() => assertListsLinuxArm64({ manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }] }),
			/doesn't list linux\/arm64 \(lists: linux\/amd64\)/,
		);
	});

	it('rejects a body that has no manifests list', () => {
		assert.throws(() => assertListsLinuxArm64({ layers: [] }), /lists: none/);
	});
});
