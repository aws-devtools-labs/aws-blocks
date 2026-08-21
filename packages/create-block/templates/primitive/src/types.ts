// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for __BB_CLASS__. Imported by the mock, aws, cdk, and browser
 * entry points. Types only — this file has zero runtime dependencies.
 */

/** A reference to an existing DynamoDB table, returned by `__BB_CLASS__.fromExisting()`. */
export interface ExternalTableRef {
	readonly __brand: 'ExternalTableRef';
	readonly tableName: string;
}

/** Options for constructing a {@link __BB_CLASS__}. */
export interface __BB_CLASS__Options {
	/**
	 * Wrap an existing DynamoDB table instead of provisioning one. Obtain the
	 * reference via `__BB_CLASS__.fromExisting(tableName)`.
	 */
	table?: ExternalTableRef;
	/**
	 * CDK-only. `'destroy'` deletes the table on stack teardown; `'retain'` keeps
	 * it. Defaults to the stack-wide preset. Ignored by the mock/browser layers.
	 */
	removalPolicy?: 'destroy' | 'retain';
}
