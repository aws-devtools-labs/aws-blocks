// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire format for browser-issued queries.
 *
 * The browser sends a *description* of the query it wants, never SQL. The server
 * validates that description against the introspected schema and an explicit table
 * allowlist, then builds the statement itself. A client is therefore mechanically
 * incapable of expressing SQL the server didn't intend to offer.
 *
 * Keep this format stable: native mobile clients will speak it too.
 *
 * @module
 */

/** Operations a client may request. */
export const DATA_API_OPERATIONS = ['select', 'count', 'insert', 'update', 'delete'] as const;

export type DataApiOperation = (typeof DATA_API_OPERATIONS)[number];

/**
 * Filter operators a client may use.
 *
 * A closed set, checked on the server. Anything absent here is rejected rather than
 * passed through to the SQL builder.
 */
export const DATA_API_OPERATORS = ['eq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is_null'] as const;

export type DataApiOperator = (typeof DATA_API_OPERATORS)[number];

/** Values a client may send. Deliberately limited to JSON scalars. */
export type ScalarValue = string | number | boolean | null;

/** One filter condition. */
export interface SerializedFilter {
	column: string;
	operator: DataApiOperator;
	/** Array only for `in`; absent for `is_null`. */
	value?: ScalarValue | ScalarValue[];
}

/** One ORDER BY term. */
export interface SerializedOrder {
	column: string;
	direction: 'asc' | 'desc';
}

/** A complete query request. Validated before anything is built from it. */
export interface QueryDescription {
	table: string;
	operation: DataApiOperation;
	/** Columns to return. Omitted means every column of the table. */
	columns?: string[];
	filters?: SerializedFilter[];
	order?: SerializedOrder[];
	limit?: number;
	offset?: number;
	/** Column values for `insert` and `update`. */
	values?: Record<string, ScalarValue>;
}
