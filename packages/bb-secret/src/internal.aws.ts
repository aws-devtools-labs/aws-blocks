// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime entry for `@aws-blocks/bb-secret/internal`.
 *
 * This subpath is for AWS Blocks' own Building Blocks only. It is not part of
 * the public API and can change in any release.
 *
 * @internal
 */

import { AppSetting } from '@aws-blocks/bb-app-setting';
import { blocksError, computeScopeFullId, type ScopeParent } from '@aws-blocks/core';
import { refreshConfig } from '@aws-blocks/core/internal';
import { SecretErrors } from './errors.js';
import { Secret } from './index.aws.js';
import { type FrameworkKey, secretArnConfigKey } from './internal-shared.js';

export { type FrameworkKey, SSM_SECRETS_STORE_WARNING_ID } from './internal-shared.js';

/**
 * Runtime side of `frameworkKey()`. Reads the key from the store this stack was
 * synthesized with, decided on every `get()`:
 *
 * - When config holds this key's Secret ARN (`BLOCKS_SECRET_ARN_<FULLID>`),
 *   the stack was synthesized with `secretsStore: 'secrets-manager'`, and the
 *   key is read from Secrets Manager. A failure is rethrown; it never falls
 *   back to SSM.
 * - Otherwise the key is read through `AppSetting` from SSM, exactly as before.
 *
 * **Stale config.** The config file is uploaded by a deployment that is not
 * ordered before the compute update, so during an upgrade deploy new code can
 * cold-start against the previous deploy's config, which has no ARN. It then
 * tries SSM, and the read fails (the same deploy removed the parameter and the
 * SSM grant). So when an SSM read fails, `get()` asks core to reload the config
 * once (`refreshConfig()`, shared and rate limited per container) and decides
 * again: if the ARN is now present it reads Secrets Manager, otherwise it
 * rethrows the original SSM error. One `get()` makes at most one reload attempt
 * and one retry. The reload also helps every other block in the container,
 * because it merges the fresh config into `process.env`.
 *
 * Construction does no I/O, so this is safe during client code generation.
 *
 * @param scope - The Building Block that owns the key (same as at synth).
 * @param id - The key's construct id (same as at synth).
 *
 * @internal
 */
export function frameworkKey(scope: ScopeParent, id: string): FrameworkKey {
	const fullId = computeScopeFullId({ id, parent: scope });
	const arnKey = secretArnConfigKey(fullId);
	// Created on first use, so only the store actually read gets a client.
	let secret: Secret | undefined;
	let setting: AppSetting | undefined;

	const readSecretsManager = async (): Promise<string> => {
		secret ??= new Secret(scope, id);
		const value = await secret.get();
		if (value === null || value === '') {
			throw blocksError(
				SecretErrors.SecretNotFound,
				`AWS Blocks key '${fullId}' has no value in Secrets Manager`,
			);
		}
		return value;
	};

	return {
		async get(): Promise<string> {
			if (process.env[arnKey]) return readSecretsManager();
			setting ??= new AppSetting(scope, id, { secret: true });
			try {
				return await setting.get();
			} catch (ssmError: unknown) {
				// The reload's own failure must not mask the error the caller
				// would otherwise see.
				await refreshConfig().catch(() => false);
				// Checked whether or not this call ran the reload: another caller's
				// reload, shared or a moment ago, may have brought the ARN in.
				if (process.env[arnKey]) return readSecretsManager();
				throw ssmError;
			}
		},
	};
}
