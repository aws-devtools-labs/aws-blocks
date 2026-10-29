// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock (local dev and test) entry for `@aws-blocks/bb-secret/internal`.
 *
 * Local dev ignores `defaults.secretsStore`: the key is the same mock
 * `AppSetting` the blocks used before the option existed, persisted under
 * `.bb-data/`.
 *
 * @internal
 */

import { AppSetting } from '@aws-blocks/bb-app-setting';
import type { ScopeParent } from '@aws-blocks/core';
import type { FrameworkKey } from './internal-shared.js';

export { type FrameworkKey, SSM_SECRETS_STORE_WARNING_ID } from './internal-shared.js';

/**
 * Mock side of `frameworkKey()`: a mock `new AppSetting(scope, id, { secret: true })`.
 *
 * @param scope - The Building Block that owns the key.
 * @param id - The key's construct id.
 *
 * @internal
 */
export function frameworkKey(scope: ScopeParent, id: string): FrameworkKey {
	const setting = new AppSetting(scope, id, { secret: true });
	return { get: () => setting.get() };
}
