// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from '@aws-blocks/core';

/** HTTP status a rejected request input maps to. */
export const VALIDATION_FAILED_STATUS = 400;

/** The `error.name` of every request-input rejection thrown by FileBucket. */
export const VALIDATION_FAILED = 'ValidationFailed';

/**
 * Build the `ValidationFailed` error FileBucket throws for a rejected request
 * input (an invalid key or prefix, an out-of-range presigned URL expiry, a
 * content type or size the bucket does not accept).
 *
 * It is an `ApiError` with status 400, so the RPC serializer answers the client
 * with HTTP 400 instead of collapsing it to a 500, while keeping the
 * `ValidationFailed` name (matchable with `isBlocksError(e, 'ValidationFailed')`
 * on the server and the client) and the name-prefixed message format that
 * core's `blocksError()` produces. Every layer — mock, AWS runtime, dev
 * file-server — builds the error through this one helper, so a rejection has the
 * same `name`, `message` and `status` wherever it happens.
 *
 * The message must be a static, FileBucket-authored string: it crosses the
 * wire, so never interpolate the caller's key, prefix or other input into it.
 *
 * @param message - The static, client-safe description of the rejection.
 */
export function validationFailed(message: string): ApiError {
	return new ApiError(`${VALIDATION_FAILED}: ${message}`, VALIDATION_FAILED_STATUS, { name: VALIDATION_FAILED });
}
