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
 * This module is the ONE place Blocks pins its own namespaces. The prefixes are
 * **scoped to the app's stable `stackId`** (from the committed `.blocks/config.json`)
 * — `/blocks/<stackId>/secrets` (Secrets Manager) and `/blocks/<stackId>/config`
 * (SSM Parameter Store) — so two Blocks apps in one account/region never collide.
 *
 * Both sides derive the scope from the SAME source: the out-of-band CLI
 * (`npm run secret`/`config`) and the CDK synth both call {@link blocksStoreConfig},
 * which reads `stackId` via {@link getStackId}. When `.blocks/config.json` is absent
 * (e.g. a bare unit test) both sides fall back to the unscoped `/blocks/secrets` /
 * `/blocks/config` identically — so the CLI write and the deploy read can never
 * diverge, whether the id is present or not. `stackId` is stage-independent
 * (prod and sandbox share it); use the opt-in `stage` segment for per-stage values.
 *
 * @module
 */

import type { StoreConfig } from '@aws-blocks/hosting';
import { secretStoreLocator } from '@aws-blocks/hosting/secret';
import { getStackId } from './scripts/stack-id.js';

/** Base Blocks prefix for `secret()` values (Secrets Manager); scoped by `stackId`. */
export const BLOCKS_SECRET_PARAMETER_PREFIX = '/blocks/secrets';

/** Base Blocks prefix for `config()` values (SSM Parameter Store); scoped by `stackId`. */
export const BLOCKS_CONFIG_PARAMETER_PREFIX = '/blocks/config';

/**
 * Resolve the app's `stackId` (stable, stage-independent, from `.blocks/config.json`),
 * or `undefined` when it can't be read. Never throws — a missing id means both the
 * CLI and synth fall back to the unscoped base prefix, so they still agree.
 */
function resolveStackId(explicit?: string): string | undefined {
	if (explicit) return explicit;
	try {
		return getStackId();
	} catch {
		return undefined;
	}
}

/** The Blocks `secret()` prefix, scoped to `stackId` when available. */
export function blocksSecretPrefix(stackId?: string): string {
	const id = resolveStackId(stackId);
	return id ? `/blocks/${id}/secrets` : BLOCKS_SECRET_PARAMETER_PREFIX;
}

/** The Blocks `config()` prefix, scoped to `stackId` when available. */
export function blocksConfigPrefix(stackId?: string): string {
	const id = resolveStackId(stackId);
	return id ? `/blocks/${id}/config` : BLOCKS_CONFIG_PARAMETER_PREFIX;
}

/**
 * The **actual store name** of a Blocks `secret()` key in AWS Secrets Manager —
 * routed through {@link secretStoreLocator} so it matches exactly what the CLI
 * writes, the IAM grant scopes to, and the runtime resolver reads. Secrets Manager
 * names are slash-free at the root, so this is `blocks/<stackId>/secrets/<KEY>`
 * (no leading slash), NOT an SSM-style path. Pass `stackId` to compute it without
 * reading `.blocks/config.json`.
 *
 * @example 'blocks/myapp/secrets/STRIPE_KEY'
 */
export function blocksSecretParameterName(key: string, stackId?: string): string {
	return secretStoreLocator(key, { prefix: blocksSecretPrefix(stackId), store: 'secrets-manager' });
}

/**
 * The **actual store name** of a Blocks `config()` key in SSM Parameter Store —
 * routed through {@link secretStoreLocator} for consistency with the CLI/grant/
 * runtime path. SSM keeps the leading-slash path.
 *
 * @example '/blocks/myapp/config/FEATURE_FLAGS'
 */
export function blocksConfigParameterName(key: string, stackId?: string): string {
	return secretStoreLocator(key, { prefix: blocksConfigPrefix(stackId), store: 'ssm' });
}

/**
 * The Blocks store config passed to the shared hosting engine — `stackId`-scoped
 * prefixes (falling back to the unscoped base when `.blocks/config.json` is absent).
 * Both the CLI and the CDK synth call this, so they resolve identical names.
 */
export function blocksStoreConfig(stackId?: string): StoreConfig {
	return {
		secretStore: { prefix: blocksSecretPrefix(stackId) },
		configStore: { prefix: blocksConfigPrefix(stackId) },
	};
}
