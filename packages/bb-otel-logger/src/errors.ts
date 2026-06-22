// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error constants for OTel Logger. Used as a marker in degraded records when
 * attribute serialization fails (not thrown to consumers).
 */
export const OtelLoggingErrors = {
	/** Context attribute serialization failed. */
	SerializationFailed: 'SerializationFailedException',
} as const;
