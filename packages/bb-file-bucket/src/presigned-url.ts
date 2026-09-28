// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const MIN_PRESIGNED_URL_EXPIRY_SECONDS = 1;
const MAX_PRESIGNED_URL_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

/**
 * Validate the TTL used in an S3 presigned URL.
 *
 * Signature Version 4 requires X-Amz-Expires to be an integer between one
 * second and seven days. Validate before creating either a local token or an
 * AWS signature so both runtimes fail consistently for invalid input.
 */
export function validatePresignedUrlExpiry(expiresIn: number): number {
	if (!Number.isInteger(expiresIn) || expiresIn < MIN_PRESIGNED_URL_EXPIRY_SECONDS || expiresIn > MAX_PRESIGNED_URL_EXPIRY_SECONDS) {
		throw blocksError(
			'ValidationFailed',
			`Presigned URL expiration must be an integer between ${MIN_PRESIGNED_URL_EXPIRY_SECONDS} and ${MAX_PRESIGNED_URL_EXPIRY_SECONDS} seconds.`,
		);
	}
	return expiresIn;
}
