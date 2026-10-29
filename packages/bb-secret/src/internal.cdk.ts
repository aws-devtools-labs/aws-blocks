// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK entry for `@aws-blocks/bb-secret/internal`.
 *
 * This subpath is for AWS Blocks' own Building Blocks only. It is not part of
 * the public API and can change in any release.
 *
 * @internal
 */

import { AppSetting } from '@aws-blocks/bb-app-setting';
import type { ScopeParent } from '@aws-blocks/core';
import { type BlocksDefaults, BlocksPresets, isSandboxContext, synthGuard } from '@aws-blocks/core/cdk';
import { Annotations, RemovalPolicy } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import { Secret } from './index.cdk.js';
import { type FrameworkKey, SSM_SECRETS_STORE_WARNING_ID } from './internal-shared.js';
import type { InternalSecretOptions } from './types.js';

export { type FrameworkKey, SSM_SECRETS_STORE_WARNING_ID } from './internal-shared.js';

/**
 * Settings for the generated value in Secrets Manager mode. 64 characters from
 * `[A-Za-z0-9]` give about 381 bits of entropy (64 * log2(62)), above the 256
 * bits of the 32 random bytes the SSM path generates. The blocks use the value
 * as a UTF-8 string (HMAC and HKDF input), so its alphabet does not matter for
 * strength; letters and digits avoid any escaping issues.
 */
const GENERATED_VALUE = { passwordLength: 64, excludePunctuation: true } as const;

/**
 * Create a key that AWS Blocks generates for one of its own Building Blocks,
 * in the store chosen by `defaults.secretsStore`.
 *
 * - `'secrets-manager'`: a bb-secret `Secret` with a CloudFormation-generated
 *   name, a CloudFormation-generated value (`GenerateSecretString`),
 *   `DeletionPolicy: Delete`, and read-only access for the app's execution
 *   role. The ARN reaches the runtime through config, as for any `Secret`.
 * - `'ssm'`: exactly `new AppSetting(scope, id, { secret: true })`, the
 *   SecureString the blocks created before this option existed. A synth-time
 *   warning fires when the stack looks like production.
 *
 * Call it at the same scope and id in the CDK and runtime layers so both
 * derive the same names. Customer secrets must not use this.
 *
 * @param scope - The Building Block that owns the key.
 * @param id - The key's construct id, unique within `scope`.
 * @returns A handle whose `get()` throws during synth.
 *
 * @internal
 */
export function frameworkKey(scope: ScopeParent, id: string): FrameworkKey {
	const defaults = resolveDefaults(scope);
	const store = defaults.secretsStore ?? BlocksPresets.production.secretsStore;

	if (store === 'secrets-manager') {
		const options: InternalSecretOptions = {
			generatedName: true,
			generatedValue: GENERATED_VALUE,
			removalPolicy: 'destroy',
		};
		new Secret(scope, id, options);
	} else if (store === 'ssm') {
		const setting = new AppSetting(scope, id, { secret: true });
		warnIfProductionLike(setting as unknown as IConstruct, defaults);
	} else {
		throw new Error(
			`Invalid defaults.secretsStore '${String(store)}' (expected 'ssm' or 'secrets-manager') for key '${id}'.`,
		);
	}

	return { get: () => synthGuard('frameworkKey', 'get') };
}

/**
 * The defaults that apply to a block created under `scope`, resolved the same
 * way as `Scope.defaults`: the scope's own defaults, then the ambient
 * `CURRENT_BLOCKS_STACK`, then the production preset. Needed because the store
 * has to be known before the key's construct exists.
 */
function resolveDefaults(scope: ScopeParent): BlocksDefaults {
	if ('defaults' in scope) {
		const own = (scope as { defaults?: BlocksDefaults }).defaults;
		if (own) return own;
	}
	const ambient = (globalThis as { CURRENT_BLOCKS_STACK?: { defaults?: BlocksDefaults } }).CURRENT_BLOCKS_STACK
		?.defaults;
	return ambient ?? BlocksPresets.production;
}

/**
 * Warn when framework keys go to SSM on a stack that looks like production:
 * not a sandbox deploy, a retained removal policy, or deletion protection on.
 */
function warnIfProductionLike(construct: IConstruct, defaults: BlocksDefaults): void {
	const reasons: string[] = [];
	if (!isSandboxContext(construct)) reasons.push("the 'sandboxMode' context is not 'true'");
	if (defaults.removalPolicy === RemovalPolicy.RETAIN) reasons.push('removalPolicy is RETAIN');
	if (defaults.deletionProtection === true) reasons.push('deletionProtection is on');
	if (reasons.length === 0) return;
	Annotations.of(construct).addWarningV2(
		SSM_SECRETS_STORE_WARNING_ID,
		`defaults.secretsStore is 'ssm', but this stack looks like production (${reasons.join(', ')}). ` +
			`The AWS Blocks key '${construct.node.id}' is stored as an SSM SecureString. ` +
			`Use secretsStore: 'secrets-manager' for production, or acknowledge this warning if SSM is deliberate.`,
	);
}
