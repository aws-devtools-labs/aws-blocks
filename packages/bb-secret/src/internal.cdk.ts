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
import { FRAMEWORK_KEY, type FrameworkKeySecretOptions } from './framework-key-options.js';
import { Secret } from './index.cdk.js';
import { type FrameworkKey, SSM_SECRETS_STORE_WARNING_ID } from './internal-shared.js';

export { type FrameworkKey, SSM_SECRETS_STORE_WARNING_ID } from './internal-shared.js';

/**
 * Create a key that AWS Blocks generates for one of its own Building Blocks,
 * in the store chosen by `defaults.secretsStore`.
 *
 * - `'secrets-manager'`: a bb-secret `Secret` with a CloudFormation-generated
 *   name, a CloudFormation-generated 64-character value
 *   (`GenerateSecretString`), `DeletionPolicy: Delete`, and only
 *   `secretsmanager:GetSecretValue` for the app's execution role. The ARN
 *   reaches the runtime as an environment variable on every compute (and in
 *   config), so the store choice arrives with the code update.
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
	const defaults = resolveDefaults(scope, id);
	// A missing field (plain JavaScript, or a cast) falls back to the production
	// preset's store, matching the fallback for a block with no owning backend.
	const store = defaults.secretsStore ?? BlocksPresets.production.secretsStore;

	if (store === 'secrets-manager') {
		const options: FrameworkKeySecretOptions = { removalPolicy: 'destroy', [FRAMEWORK_KEY]: true };
		new Secret(scope, id, options);
	} else if (store === 'ssm') {
		const setting = new AppSetting(scope, id, { secret: true });
		// Under `--conditions=cdk` this is bb-app-setting's CDK construct, but its
		// TypeScript types always resolve to the mock entry (the package's `types`
		// condition), which is not an `IConstruct`. The cast reflects the runtime
		// value, not a type error in the construct.
		warnIfProductionLike(setting as unknown as IConstruct, defaults);
	} else {
		throw new Error(
			`Invalid defaults.secretsStore '${String(store)}' (expected 'ssm' or 'secrets-manager') for key '${id}'.`,
		);
	}

	return { get: () => synthGuard('frameworkKey', 'get') };
}

/**
 * The defaults that apply to a block created under `scope`. The store has to be
 * known before the key's construct exists, so this cannot read the new
 * construct's own `defaults`.
 *
 * A Building Block parent (the normal case) and a `BlocksStack` / `BlocksBackend`
 * expose `defaults`, and `Scope.defaults` already applies the full resolution
 * (owning backend, ambient stack, production preset with a warning). A bare
 * `{ id }` parent falls back to the ambient stack, then to the production
 * preset with the same kind of warning.
 */
function resolveDefaults(scope: ScopeParent, id: string): BlocksDefaults {
	const own = (scope as { defaults?: BlocksDefaults }).defaults;
	if (own) return own;
	const ambient = (globalThis as { CURRENT_BLOCKS_STACK?: { defaults?: BlocksDefaults } }).CURRENT_BLOCKS_STACK
		?.defaults;
	if (ambient) return ambient;
	console.warn(
		`[Blocks] frameworkKey '${id}' resolved infrastructure defaults with no owning BlocksStack/BlocksBackend; ` +
			'using BlocksPresets.production.',
	);
	return BlocksPresets.production;
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
