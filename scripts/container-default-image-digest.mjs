// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Prints the current multi-arch index digest of the ContainerCompute default
// image tag (node:24-slim) on ECR Public and compares it with the digest pinned in
// packages/bb-container-compute/src/default-image.ts. Dependabot doesn't track
// that constant, so this is the bump path: run it, paste the printed reference
// into DEFAULT_CONTAINER_IMAGE, run the package's tests and add a changeset.
//
// Run: node scripts/container-default-image-digest.mjs
// Exit code: 0 when the pin matches the tag's current digest, 1 when it is
// behind (or not a digest reference), 2 on a registry or network error.
//
// Uses ECR Public's anonymous pull token and the OCI distribution API; no
// Docker, crane or AWS credentials needed.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'public.ecr.aws';
const REPOSITORY = 'docker/library/node';
const TAG = '24-slim';
const ACCEPT = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'packages/bb-container-compute/src/default-image.ts'), 'utf8');
// Anchored to the assignment, so a mention of the name in a comment can't shift the match.
const pinned = /DEFAULT_CONTAINER_IMAGE\s*=\s*'([^']+)'/.exec(source)?.[1];

async function currentDigest() {
	const tokenRes = await fetch(`https://${REGISTRY}/token/?scope=repository:${REPOSITORY}:pull`);
	if (!tokenRes.ok) throw new Error(`token request failed: HTTP ${tokenRes.status}`);
	const { token } = await tokenRes.json();
	const res = await fetch(`https://${REGISTRY}/v2/${REPOSITORY}/manifests/${TAG}`, {
		method: 'HEAD',
		headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT },
	});
	if (!res.ok) throw new Error(`manifest request failed: HTTP ${res.status}`);
	const digest = res.headers.get('docker-content-digest');
	if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`unexpected digest header: ${digest}`);
	return digest;
}

let digest;
try {
	digest = await currentDigest();
} catch (err) {
	console.error(`Could not resolve ${REGISTRY}/${REPOSITORY}:${TAG}: ${err instanceof Error ? err.message : err}`);
	process.exit(2);
}

// Digest-only reference (`repository@sha256:…`), the form ECS documents for `image`.
const latest = `${REGISTRY}/${REPOSITORY}@${digest}`;
console.log(`current: ${latest} (${TAG})`);
console.log(`pinned:  ${pinned ?? '(not found)'}`);
if (pinned === latest) {
	console.log('The pinned default image is current.');
} else {
	console.log('The pinned default image is behind the tag. Update DEFAULT_CONTAINER_IMAGE to the current reference.');
	process.exit(1);
}
