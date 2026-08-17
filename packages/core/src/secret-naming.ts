// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Blocks-owned namespaces for hosting values.
 *
 * The mechanism (markers, resolvers, path/env naming) lives in the
 * framework-neutral `@aws-blocks/hosting` package, which defaults to neutral
 * `/hosting/secrets` and `/hosting/config` prefixes so a non-Blocks consumer
 * never inherits Blocks branding.
 *
 * This module is the ONE place Blocks pins its own namespaces — `/blocks/secrets`
 * (Secrets Manager) and `/blocks/config` (SSM Parameter Store) — so every
 * Blocks-side caller (the `secret`/`config` CLIs and the CDK wiring) is consistent.
 *
 * @module
 */

import type { StoreConfig } from '@aws-blocks/hosting';
import { parameterName } from '@aws-blocks/hosting/secret';

/** Blocks prefix for `secret()` values (Secrets Manager). */
export const BLOCKS_SECRET_PARAMETER_PREFIX = '/blocks/secrets';

/** Blocks prefix for `config()` values (SSM Parameter Store). */
export const BLOCKS_CONFIG_PARAMETER_PREFIX = '/blocks/config';

/** Blocks-namespaced name for a secret key. @example '/blocks/secrets/STRIPE_KEY' */
export function blocksSecretParameterName(key: string): string {
	return parameterName(key, BLOCKS_SECRET_PARAMETER_PREFIX);
}

/** Blocks-namespaced name for a config key. @example '/blocks/config/FEATURE_FLAGS' */
export function blocksConfigParameterName(key: string): string {
	return parameterName(key, BLOCKS_CONFIG_PARAMETER_PREFIX);
}

/** The Blocks store config (pinned prefixes) passed to the shared hosting engine. */
export function blocksStoreConfig(): StoreConfig {
	return {
		secretStore: { prefix: BLOCKS_SECRET_PARAMETER_PREFIX },
		configStore: { prefix: BLOCKS_CONFIG_PARAMETER_PREFIX },
	};
}
