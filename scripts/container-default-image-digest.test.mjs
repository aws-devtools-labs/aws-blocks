// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/container-default-image-digest.mjs: the offline checks,
// and run()'s exit codes against a stubbed registry. The live registry calls run
// in the `Container default image digest` workflow.
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
	run,
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

describe('run (exit codes, stubbed registry)', () => {
	const INDEX_TYPE = INDEX_MEDIA_TYPES[0];
	const PINNED = `public.ecr.aws/docker/library/node@${DIGEST}`;
	const NEWER = `sha256:${'b'.repeat(64)}`;
	const pinSource = (ref) => `export const DEFAULT_CONTAINER_IMAGE =\n\t'${ref}'; // node:24-slim\n`;
	const ARM64_INDEX = { manifests: [{ platform: { os: 'linux', architecture: 'arm64' } }] };

	/** A registry stub. Each override replaces one response; the defaults describe a valid, current pin. */
	function registry({ token, pinned, tag } = {}) {
		return async (url, init = {}) => {
			if (url.includes('/token/')) return token ? token() : Response.json({ token: 't' });
			if (url.endsWith(`/manifests/${DIGEST}`)) {
				return pinned
					? pinned()
					: new Response(JSON.stringify(ARM64_INDEX), { headers: { 'content-type': INDEX_TYPE } });
			}
			if (url.endsWith('/manifests/24-slim') && init.method === 'HEAD') {
				return tag
					? tag()
					: new Response(null, { headers: { 'content-type': INDEX_TYPE, 'docker-content-digest': DIGEST } });
			}
			throw new Error(`unexpected request: ${init.method ?? 'GET'} ${url}`);
		};
	}

	async function exitCode({ source = pinSource(PINNED), readFile, ...responses } = {}) {
		const output = [];
		const code = await run({
			fetch: registry(responses),
			readFile: readFile ?? (() => source),
			log: (line) => output.push(line),
			error: (line) => output.push(line),
		});
		return { code, output: output.join('\n') };
	}

	it('exits 0 when the pin is valid and current', async () => {
		assert.equal((await exitCode()).code, 0);
	});

	it('exits 1 when the pin is valid but behind the tag', async () => {
		const tag = () =>
			new Response(null, { headers: { 'content-type': INDEX_TYPE, 'docker-content-digest': NEWER } });
		const { code, output } = await exitCode({ tag });
		assert.equal(code, 1);
		assert.match(output, new RegExp(`current: public\\.ecr\\.aws/docker/library/node@${NEWER}`));
	});

	it('exits 3 when the pin file is missing, not 1 (which means behind)', async () => {
		const readFile = () => {
			throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
		};
		const { code, output } = await exitCode({ readFile });
		assert.equal(code, 3);
		assert.match(output, /ENOENT/);
	});

	it('exits 3 when the file has no DEFAULT_CONTAINER_IMAGE assignment', async () => {
		assert.equal((await exitCode({ source: 'export const OTHER = 1;\n' })).code, 3);
	});

	it('exits 3 when the pin is a tag, not a digest', async () => {
		assert.equal((await exitCode({ source: pinSource('public.ecr.aws/docker/library/node:24-slim') })).code, 3);
	});

	it("exits 3 when the pinned digest doesn't resolve (404)", async () => {
		const pinned = () => new Response('not found', { status: 404 });
		assert.equal((await exitCode({ pinned })).code, 3);
	});

	it('exits 3 when the pinned digest is a single-platform manifest', async () => {
		const pinned = () =>
			new Response(JSON.stringify({ layers: [] }), {
				headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json' },
			});
		assert.equal((await exitCode({ pinned })).code, 3);
	});

	it("exits 3 when the pinned index doesn't list linux/arm64", async () => {
		const pinned = () =>
			new Response(JSON.stringify({ manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }] }), {
				headers: { 'content-type': INDEX_TYPE },
			});
		assert.equal((await exitCode({ pinned })).code, 3);
	});

	it('exits 2 when the pinned manifest request fails with a non-404 status', async () => {
		const pinned = () => new Response('oops', { status: 500 });
		assert.equal((await exitCode({ pinned })).code, 2);
	});

	it('exits 2, not 3, when the pinned index body is not JSON', async () => {
		const pinned = () => new Response('{"manifests": [', { headers: { 'content-type': INDEX_TYPE } });
		assert.equal((await exitCode({ pinned })).code, 2);
	});

	it('exits 2 when the token request fails', async () => {
		const token = () => new Response('denied', { status: 503 });
		assert.equal((await exitCode({ token })).code, 2);
	});

	it('exits 2 when fetch itself rejects (network error)', async () => {
		const token = () => Promise.reject(new TypeError('fetch failed'));
		assert.equal((await exitCode({ token })).code, 2);
	});

	it("exits 2 when the tag's manifest request fails", async () => {
		const tag = () => new Response(null, { status: 500 });
		assert.equal((await exitCode({ tag })).code, 2);
	});

	it("exits 2 when the tag's HEAD response isn't an image index", async () => {
		const tag = () =>
			new Response(null, {
				headers: {
					'content-type': 'application/vnd.oci.image.manifest.v1+json',
					'docker-content-digest': DIGEST,
				},
			});
		const { code, output } = await exitCode({ tag });
		assert.equal(code, 2);
		assert.match(output, /is not an image index/);
	});

	it("exits 2 when the tag's digest header is missing", async () => {
		const tag = () => new Response(null, { headers: { 'content-type': INDEX_TYPE } });
		const { code, output } = await exitCode({ tag });
		assert.equal(code, 2);
		assert.match(output, /unexpected digest header/);
	});
});
