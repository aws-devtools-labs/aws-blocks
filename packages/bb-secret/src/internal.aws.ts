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
import { SecretErrors } from './errors.js';
import { Secret } from './index.aws.js';
import { type FrameworkKey, secretArnConfigKey } from './internal-shared.js';

export { type FrameworkKey, SSM_SECRETS_STORE_WARNING_ID } from './internal-shared.js';

/**
 * Runtime side of `frameworkKey()`. Reads the key from the store this stack was
 * synthesized with:
 *
 * - When config holds this key's Secret ARN (`BLOCKS_SECRET_ARN_<FULLID>`),
 *   the stack was synthesized with `secretsStore: 'secrets-manager'`, and the
 *   key is read from Secrets Manager.
 * - Otherwise it was synthesized with `'ssm'`, and the key is read through
 *   `AppSetting` exactly as before.
 *
 * The choice is made once, at construction. There is no fallback from one
 * store to the other.
 *
 * @param scope - The Building Block that owns the key (same as at synth).
 * @param id - The key's construct id (same as at synth).
 *
 * @internal
 */
export function frameworkKey(scope: ScopeParent, id: string): FrameworkKey {
	const fullId = computeScopeFullId({ id, parent: scope });
	if (process.env[secretArnConfigKey(fullId)]) {
		const secret = new Secret(scope, id);
		return {
			async get(): Promise<string> {
				const value = await secret.get();
				if (value === null || value === '') {
					throw blocksError(
						SecretErrors.SecretNotFound,
						`AWS Blocks key '${fullId}' has no value in Secrets Manager`,
					);
				}
				return value;
			},
		};
	}
	const setting = new AppSetting(scope, id, { secret: true });
	return { get: () => setting.get() };
}
