// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation of query results against the `schema` option: a Standard Schema
 * (Zod, Valibot, ArkType, …) applied to every row, whose output becomes the row.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { resultValidationFailed } from './errors.js';

/** Validate one row; returns the schema's output. */
export async function validateRow<T>(row: unknown, schema: StandardSchemaV1<unknown, T>, index: number): Promise<T> {
	const result = schema['~standard'].validate(row);
	const resolved = result instanceof Promise ? await result : result;
	if (resolved.issues) throw resultValidationFailed(index, resolved.issues);
	return resolved.value;
}

/** Validate every row in order; without a schema the rows pass through unchanged. */
export async function validateRows<T>(rows: T[], schema: StandardSchemaV1<unknown, T> | undefined): Promise<T[]> {
	if (!schema) return rows;
	const out: T[] = [];
	for (const [index, row] of rows.entries()) out.push(await validateRow(row, schema, index));
	return out;
}
