// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pieces of `@aws-blocks/bb-secret/internal` shared by every runtime variant.
 * No AWS SDK or CDK imports, so the browser, mock, AWS and CDK entries can all
 * load it.
 *
 * @internal
 */

/**
 * A key that AWS Blocks generates for one of its own Building Blocks (for
 * example the `Realtime` connection token key). Returned by `frameworkKey()`.
 *
 * @internal
 */
export interface FrameworkKey {
	/**
	 * Read the key. At runtime it reads from the store this stack was
	 * synthesized with. Under CDK synth it throws, like every Building Block
	 * data method.
	 *
	 * @returns The key, a non-empty string. Consumers use it as a UTF-8 string
	 *   (HMAC and HKDF input), never as decoded bytes.
	 */
	get(): Promise<string>;
}

/**
 * Warning id emitted at synth when framework keys are stored in SSM on a stack
 * that looks like production. Acknowledge with
 * `Annotations.of(stack).acknowledgeWarning(SSM_SECRETS_STORE_WARNING_ID)`.
 *
 * @internal
 */
export const SSM_SECRETS_STORE_WARNING_ID = '@aws-blocks/bb-secret:SsmSecretsStoreOutsideSandbox';

/**
 * The config key under which the CDK `Secret` registers its ARN. Must match the
 * private `configKey()` in `index.cdk.ts` and `index.aws.ts`; a synth test
 * checks that it does.
 *
 * @internal
 */
export function secretArnConfigKey(fullId: string): string {
	return `BLOCKS_SECRET_ARN_${fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}
