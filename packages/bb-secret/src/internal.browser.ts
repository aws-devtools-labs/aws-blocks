// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub for `@aws-blocks/bb-secret/internal`. Framework keys are
// server-side only, so creating one in client code throws.
import type { ScopeParent } from '@aws-blocks/core';
import { SecretErrors } from './errors.js';
import type { FrameworkKey } from './internal-shared.js';

export { type FrameworkKey, SSM_SECRETS_STORE_WARNING_ID } from './internal-shared.js';

// Same local helper as `index.browser.ts`.
function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

/** @internal */
export function frameworkKey(_scope: ScopeParent, _id: string): FrameworkKey {
	throw blocksError(
		SecretErrors.NotSupported,
		'frameworkKey() cannot be used in browser/client code. It runs server-side only.',
	);
}
