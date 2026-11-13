// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ExternalUserPoolRef } from './types.js';

/**
 * Build an {@link ExternalUserPoolRef}. Every entry point's `Auth.fromExisting`
 * delegates here, so the brand string has one source of truth. Pure and
 * dependency-free, so the browser entry can use it too.
 *
 * @internal
 */
export function makeExternalUserPoolRef(userPoolId: string, clientId?: string): ExternalUserPoolRef {
	return { __brand: 'ExternalUserPoolRef', userPoolId, clientId };
}
