// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { brandBlocksError } from '@aws-blocks/core';

/**
 * S3 bucket-name validation, shared by the CDK (synth) and mock (local dev)
 * entry points so a name that would be rejected by CloudFormation fails the
 * same way during `bb dev` — long before a deploy is attempted.
 *
 * Bucket names are derived from the scope chain (`scope.fullId`). Because S3
 * bucket names are globally unique and immutable, we deliberately error rather
 * than silently truncate/hash: a truncated name could collide, and a name that
 * shifts between deploys would orphan or replace the customer's data. The fix
 * belongs in the developer's hands — shorten a scope id once and the name is
 * stable forever.
 *
 * Rules enforced (AWS general-purpose bucket naming):
 * - 3–63 characters
 * - lowercase letters, numbers, dots (`.`), and hyphens (`-`) only
 * - must begin and end with a letter or number
 * - must not contain two adjacent dots
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
 */

const MIN_LEN = 3;
const MAX_LEN = 63;

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return brandBlocksError(err);
}

/**
 * Validate an auto-derived S3 bucket name. Throws a `ValidationFailed` error
 * with an actionable message when the name violates an S3 naming rule.
 *
 * @param name - The bucket name (the scope's `fullId`).
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
