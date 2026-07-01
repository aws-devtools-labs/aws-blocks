// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Blocks-owned SSM namespace for hosting secrets.
 *
 * The secret *mechanism* (marker, runtime resolver, path/env naming) lives in
 * the framework-neutral `@aws-blocks/hosting` package, which defaults to a
 * neutral `/aws-hosting/secrets` prefix so a non-Blocks consumer (a plain
 * framework app, a future standalone hosting package) never inherits Blocks
 * branding.
 *
 * This module is the ONE place Blocks pins its own namespace. Every Blocks-side
 * caller — the `secret` CLI (`scripts/secret.ts`) and the CDK wiring
 * (`hosting-secrets.ts`) — routes through {@link blocksSecretParameterName} so
 * Blocks secrets consistently land at `/blocks/secrets/<KEY>`, alongside the
 * existing `/blocks/{stage}/db-connection-string` convention. Keeping the prefix
 * here (not in the hosting leaf) is what makes the future extraction of the
 * secret mechanism into a standalone package a mechanical move rather than a
 * breaking SSM-path migration.
 *
 * @module
 */

import { secretParameterName } from '@aws-blocks/hosting/secret';

/** Blocks SSM prefix for hosting secrets. Blocks pins `/blocks`; the leaf stays neutral. */
export const BLOCKS_SECRET_PARAMETER_PREFIX = '/blocks/secrets';

/**
 * Blocks-namespaced SSM parameter name for a secret key.
 * Thin wrapper over the neutral {@link secretParameterName} that always injects
 * the Blocks prefix, so callers can't accidentally use the neutral default.
 *
 * @example blocksSecretParameterName('STRIPE_KEY') // '/blocks/secrets/STRIPE_KEY'
 */
export function blocksSecretParameterName(key: string): string {
	return secretParameterName(key, BLOCKS_SECRET_PARAMETER_PREFIX);
}
