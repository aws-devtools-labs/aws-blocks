// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared by the mock and aws-runtime entries. Kept out of errors.ts so the
// browser entry, which re-exports SecretErrors, does not import core.

import { brandBlocksError } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { SecretErrors } from './errors.js';

/**
 * Build the `SecretErrors.ValidationFailed` error for a schema rejection.
 *
 * The message, which reaches the RPC caller, is fixed and carries no part of
 * the input. Schema libraries often quote the received value in their issue
 * messages (zod: `… received 's3cr3t'`), and record or map schemas report the
 * input's own keys as the issue path, so both the first issue's message and its
 * `path` stay on the non-enumerable `cause`, with the full `issues` array, for
 * server-side logs.
 */
export function secretValidationFailed(issues: ReadonlyArray<StandardSchemaV1.Issue>): Error {
	const path = issues[0]?.path
		?.map((segment) => String(typeof segment === 'object' ? segment.key : segment))
		.join('.');
	const cause = Object.assign(new Error(issues[0]?.message ?? 'the secret value did not match the schema'), {
		issues,
		path,
	});
	const name = SecretErrors.ValidationFailed;
	const error = new Error(`${name}: The secret value did not match the schema`, { cause });
	error.name = name;
	return brandBlocksError(error);
}

/** Validate `value` against `schema`, throwing {@link secretValidationFailed} on rejection. */
export async function validateSchema<T>(schema: StandardSchemaV1<T>, value: unknown): Promise<T> {
	const result = schema['~standard'].validate(value);
	const resolved = result instanceof Promise ? await result : result;
	if (resolved.issues) {
		throw secretValidationFailed(resolved.issues);
	}
	return (resolved as { value: T }).value;
}
