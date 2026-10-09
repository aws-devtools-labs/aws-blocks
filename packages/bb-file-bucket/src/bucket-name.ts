// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { brandBlocksError } from '@aws-blocks/core';

/**
 * S3 bucket-name validation, shared by the CDK (synth) and mock (local dev)
 * entry points so a name that would be rejected by CloudFormation fails the
 * same way during `bb dev` — long before a deploy is attempted.
 *
 * Bucket names are derived from the scope chain (`scope.fullId`) by
 * {@link deriveBucketName}. Because S3 bucket names are globally unique and
 * immutable, a name must never shift between deploys — that would orphan or
 * replace the customer's data. So a `fullId` that already fits in 63
 * characters is used byte-identical, and only an over-long `fullId` is
 * shortened, deterministically: a truncated prefix plus a short hash of the
 * whole `fullId`. Plain truncation could collide; the hash keeps distinct
 * scope chains distinct. (Over-long names used to be rejected at synth, so no
 * deployed bucket carries one and the shortened form changes no existing name.)
 * Every other naming rule is still an error — the fix for those belongs in the
 * developer's hands: shorten or rename a scope id once and the name is stable
 * forever.
 *
 * Rules enforced (AWS general-purpose bucket naming):
 * - 3–63 characters
 * - lowercase letters, numbers, dots (`.`), and hyphens (`-`) only
 * - must begin and end with a letter or number
 * - must not contain two adjacent dots
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
 */

import { createHash } from 'node:crypto';

const MIN_LEN = 3;
const MAX_LEN = 63;
/** Hex characters of `sha256(fullId)` appended to a shortened name. */
const HASH_LEN = 8;

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return brandBlocksError(err);
}

/**
 * Derive the physical S3 bucket name for a `FileBucket` from its `fullId`.
 *
 * - `fullId` of 63 characters or fewer: returned unchanged, so every bucket that
 *   could already be deployed keeps its exact name.
 * - Longer `fullId`: the first characters of `fullId` (any trailing `-`/`.`
 *   trimmed), then `-`, then the first 8 hex characters of `sha256(fullId)` —
 *   at most 63 characters. The same pattern `bb-auth` uses for the hosted-UI
 *   domain prefix.
 *
 * Pure and deterministic: the CDK, AWS-runtime, and mock layers each call it on
 * the same `fullId` and resolve the same name, with nothing handed between them.
 * The result is not validated here — pass it to {@link validateBucketName}.
 *
 * ⚠️ **Frozen once deployed.** Changing this output for any input renames — and
 * so replaces — a deployed bucket. `bucket-name.test.ts` pins it.
 *
 * @param fullId - The FileBucket's scope `fullId`.
 * @returns The bucket name to provision and address.
 */
export function deriveBucketName(fullId: string): string {
	if (fullId.length <= MAX_LEN) return fullId;
	const hash = createHash('sha256').update(fullId).digest('hex').slice(0, HASH_LEN);
	// Trim a trailing `-`/`.` at the cut so the result never holds `--` or `.-`. An
	// all-separator prefix trims to '' and yields a leading `-`, which
	// validateBucketName rejects exactly as it would the original name.
	const base = fullId.slice(0, MAX_LEN - HASH_LEN - 1).replace(/[-.]+$/, '');
	return `${base}-${hash}`;
}

/**
 * Validate an auto-derived S3 bucket name. Throws a `ValidationFailed` error
 * with an actionable message when the name violates an S3 naming rule.
 *
 * @param name - The bucket name ({@link deriveBucketName} of the scope's `fullId`).
 * @throws {Error} With name `ValidationFailed` if the name is invalid.
 */
export function validateBucketName(name: string): void {
	const hint =
		`FileBucket names are derived from the scope chain (id of the bucket ` +
		`plus its parent scopes, joined with "-"). Shorten the FileBucket id ` +
		`or a parent scope id, or pass an existing bucket via ` +
		`FileBucket.fromExisting(...).`;

	if (name.length > MAX_LEN) {
		throw blocksError(
			'ValidationFailed',
			`Derived bucket name "${name}" is ${name.length} characters, ` +
				`exceeding S3's ${MAX_LEN}-character limit. ${hint}`,
		);
	}
	if (name.length < MIN_LEN) {
		throw blocksError(
			'ValidationFailed',
			`Derived bucket name "${name}" is ${name.length} characters; ` +
				`S3 requires at least ${MIN_LEN}. ${hint}`,
		);
	}
	if (!/^[a-z0-9.-]+$/.test(name)) {
		throw blocksError(
			'ValidationFailed',
			`Derived bucket name "${name}" contains characters that are invalid ` +
				`for an S3 bucket. Use only lowercase letters, numbers, dots (.), ` +
				`and hyphens (-). ${hint}`,
		);
	}
	if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) {
		throw blocksError(
			'ValidationFailed',
			`Derived bucket name "${name}" must begin and end with a lowercase ` +
				`letter or number. ${hint}`,
		);
	}
	if (name.includes('..')) {
		throw blocksError(
			'ValidationFailed',
			`Derived bucket name "${name}" must not contain two adjacent dots. ${hint}`,
		);
	}
}
