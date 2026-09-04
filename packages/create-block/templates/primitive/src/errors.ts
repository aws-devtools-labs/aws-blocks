// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error constants for __BB_CLASS__. Match them in catch blocks with
 * `isBlocksError(e, __BB_CLASS__Errors.Foo)` from `@aws-blocks/core` — errors
 * cross the wire by `name`, so the same guard works server- and client-side.
 */
export const __BB_CLASS__Errors = {
	/** TODO: rename/extend for this block's real failure modes. */
	InvalidInput: 'InvalidInputException',
} as const;
