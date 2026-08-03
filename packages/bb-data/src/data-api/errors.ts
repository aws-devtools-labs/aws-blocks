// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Errors raised by the browser-facing data API.
 *
 * Errors cross the wire by `name`, so match them with
 * `isBlocksError(e, DataApiErrors.NotAuthenticated)` on either side.
 */
export const DataApiErrors = {
	/** No authenticated caller. The API has no anonymous mode. */
	NotAuthenticated: 'NotAuthenticatedException',
	/** The request was malformed or asked for something not allowed. */
	InvalidQuery: 'InvalidQueryException',
	/** The table exists but was not opted in via `tables`. */
	TableNotExposed: 'TableNotExposedException',
} as const;

/** Create an `Error` carrying one of the {@link DataApiErrors} names. */
export function blocksError(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}
