// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ExternalMetricsRef } from './types.js';

/**
 * Build the reference `Metrics.fromExisting()` returns. Shared by every entry
 * (runtime, cdk, browser) so the brand is defined once; dependency-free so the
 * browser entry can import it.
 */
export const externalMetricsRef = (namespace: string): ExternalMetricsRef => ({
	__brand: 'ExternalMetricsRef',
	namespace,
});
