// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Prints the current multi-arch index digest of the ContainerCompute default
// image tag (node:24-slim) on ECR Public and compares it with the digest pinned in
// packages/bb-container-compute/src/default-image.ts. Dependabot doesn't track
// that constant, so this is the bump path: run it, paste the printed reference
// into DEFAULT_CONTAINER_IMAGE, run the package's tests and add a changeset.
//
// It also verifies the pin itself against the registry: the pinned digest must
// resolve, the registry must serve it as an image index (not a single-platform
// manifest), and the index must list linux/arm64, the platform ContainerCompute
// runs on. A unit test can only check the reference's shape; this is the check
// that a typo'd or single-platform digest fails in CI rather than at deploy.
//
// Run: node scripts/container-default-image-digest.mjs
// Exit code: 0 when the pin is valid and matches the tag's current digest,
// 1 when it is valid but behind the tag, 2 on a registry or network error,
// 3 when the pin is invalid (the pin file can't be read, isn't a digest
// reference, doesn't resolve, isn't an image index, or doesn't list linux/arm64).
// Any failure maps to 2 or 3, so 1 always means "behind"; the workflow treats any
// other code (a crash, an abort) as a failure too.
//
// Uses ECR Public's anonymous pull token and the OCI distribution API; no
// Docker, crane or AWS credentials needed.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'public.ecr.aws';
const REPOSITORY = 'docker/library/node';
const TAG = '24-slim';
/** The two image-index media types. A digest is only the multi-arch index digest when the response is one of them. */
export const INDEX_MEDIA_TYPES = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
];
const ACCEPT = INDEX_MEDIA_TYPES.join(', ');
const PINNED_REFERENCE = /^public\.ecr\.aws\/docker\/library\/node@(sha256:[0-9a-f]{64})$/;

/** The pin is unusable (exit 3), as opposed to a registry or network error (exit 2). */
export class InvalidPinError extends Error {}

/** Reads the value assigned to `DEFAULT_CONTAINER_IMAGE`. Anchored to the assignment, so a mention of the name in a comment can't shift the match. */
export function readPinned(source) {
	return /DEFAULT_CONTAINER_IMAGE\s*=\s*'([^']+)'/.exec(source)?.[1];
}

/** Returns the digest of a `public.ecr.aws/docker/library/node@sha256:<64 hex>` reference, or throws InvalidPinError. */
export function pinnedDigest(reference) {
	const digest = reference && PINNED_REFERENCE.exec(reference)?.[1];
	if (!digest) throw new InvalidPinError(`not a ${REGISTRY}/${REPOSITORY}@sha256:<64 hex> reference: ${reference}`);
	return digest;
}

/** Throws unless the response's media type is an image index. Parameters (`; charset=…`) are ignored. */
export function assertIndexMediaType(contentType, what) {
	const mediaType = contentType?.split(';')[0].trim().toLowerCase();
	if (!mediaType || !INDEX_MEDIA_TYPES.includes(mediaType)) {
		throw new Error(`${what} is not an image index (Content-Type: ${contentType ?? 'missing'})`);
	}
}

/** Throws unless the image index lists a linux/arm64 image manifest. */
export function assertListsLinuxArm64(index) {
	const platforms = (Array.isArray(index?.manifests) ? index.manifests : []).map((m) => m?.platform);
	if (!platforms.some((p) => p?.os === 'linux' && p?.architecture === 'arm64')) {
		const listed = platforms.map((p) => `${p?.os}/${p?.architecture}`).join(', ') || 'none';
		throw new Error(`the index doesn't list linux/arm64 (lists: ${listed})`);
	}
}

async function pullToken(fetch) {
	const res = await fetch(`https://${REGISTRY}/token/?scope=repository:${REPOSITORY}:pull`);
	if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);
	const { token } = await res.json();
	return token;
}

function manifest(fetch, token, reference, method) {
	return fetch(`https://${REGISTRY}/v2/${REPOSITORY}/manifests/${reference}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT },
	});
}

/** The tag's current index digest. */
async function currentDigest(fetch, token) {
	const res = await manifest(fetch, token, TAG, 'HEAD');
	if (!res.ok) throw new Error(`manifest request for ${TAG} failed: HTTP ${res.status}`);
	// The digest header is only the multi-arch index digest when the registry served an index.
	assertIndexMediaType(res.headers.get('content-type'), `${TAG}'s manifest`);
	const digest = res.headers.get('docker-content-digest');
	if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`unexpected digest header: ${digest}`);
	return digest;
}

/** Throws InvalidPinError unless the pinned digest resolves to an image index that lists linux/arm64. */
async function verifyPinned(fetch, token, digest) {
	const res = await manifest(fetch, token, digest, 'GET');
	// ECR Public answers an unknown digest with 404; anything else non-OK is a registry error.
	if (res.status === 404) throw new InvalidPinError(`the pinned digest ${digest} doesn't resolve (HTTP 404)`);
	if (!res.ok) throw new Error(`manifest request for ${digest} failed: HTTP ${res.status}`);
	// Parsed outside the try below: a truncated or non-JSON body is a registry error (exit 2), not an invalid pin.
	const body = await res.json();
	try {
		assertIndexMediaType(res.headers.get('content-type'), 'the pinned digest');
		assertListsLinuxArm64(body);
	} catch (err) {
		throw new InvalidPinError(err instanceof Error ? err.message : String(err));
	}
}

const PIN_FILE = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'packages/bb-container-compute/src/default-image.ts',
);

/**
 * Runs the check and returns the exit code (see the header), instead of exiting.
 * Every failure, including a missing pin file, maps to 2 or 3, so 1 always means "behind".
 * The dependencies are injectable for the tests.
 */
export async function run({
	fetch = globalThis.fetch,
	readFile = (path) => readFileSync(path, 'utf8'),
	log = console.log,
	error = console.error,
} = {}) {
	let pinned;
	try {
		pinned = readPinned(readFile(PIN_FILE));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		error(`The pinned default image is invalid: can't read ${PIN_FILE}: ${message}`);
		return 3;
	}
	log(`pinned:  ${pinned ?? '(not found)'}`);
	try {
		const digest = pinnedDigest(pinned);
		const token = await pullToken(fetch);
		await verifyPinned(fetch, token, digest);
		log('The pinned digest resolves to an image index that lists linux/arm64.');
		// Digest-only reference (`repository@sha256:…`), the form ECS documents for `image`.
		const latest = `${REGISTRY}/${REPOSITORY}@${await currentDigest(fetch, token)}`;
		log(`current: ${latest} (${TAG})`);
		if (pinned === latest) {
			log('The pinned default image is current.');
			return 0;
		}
		log('The pinned default image is behind the tag. Update DEFAULT_CONTAINER_IMAGE to the current reference.');
		return 1;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (err instanceof InvalidPinError) {
			error(`The pinned default image is invalid: ${message}`);
			return 3;
		}
		error(`Could not check ${REGISTRY}/${REPOSITORY}: ${message}`);
		return 2;
	}
}

// Run only when executed directly, not when imported by the tests. Compare real
// paths: import.meta.url is resolved through symlinks, process.argv[1] isn't.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run();
