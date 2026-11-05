// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Package-private marker that switches a CDK `Secret` into framework key mode.
 * Only `frameworkKey()` in `./internal.cdk.ts` sets it.
 *
 * The marker is a module-private `Symbol` (not `Symbol.for`), so customer code
 * cannot produce it: a plain options object, even one built in a variable or in
 * JavaScript, never turns framework key mode on. This file is not reachable
 * through the package's `exports` map.
 *
 * @internal
 */

import type { SecretOptions } from './types.js';

/** @internal */
export const FRAMEWORK_KEY = Symbol('aws-blocks.bb-secret.frameworkKey');

/**
 * `Secret` options as `frameworkKey()` passes them. With the marker set, the
 * CDK `Secret`:
 *
 * - leaves `Name` unset, so CloudFormation generates a unique name;
 * - seeds the value from `GenerateSecretString` with {@link FRAMEWORK_KEY_VALUE};
 * - grants the app role only `secretsmanager:GetSecretValue`;
 * - also sets its ARN as an environment variable on every compute, so new code
 *   never reads a stale config object during a deploy.
 *
 * @internal
 */
export type FrameworkKeySecretOptions = SecretOptions<string> & { readonly [FRAMEWORK_KEY]?: true };

/**
 * The generated value in Secrets Manager mode. 64 characters from `[A-Za-z0-9]`
 * give about 381 bits of entropy (64 * log2(62)), above the 256 bits of the 32
 * random bytes the SSM path generates. Consumers use the value as a UTF-8
 * string (HMAC input), so the alphabet does not affect strength; letters and
 * digits avoid any escaping issues.
 *
 * @internal
 */
export const FRAMEWORK_KEY_VALUE = { passwordLength: 64, excludePunctuation: true } as const;

/** Whether `options` carries the framework key marker. @internal */
export function isFrameworkKeyOptions(options: SecretOptions<unknown> | undefined): boolean {
	return (options as FrameworkKeySecretOptions | undefined)?.[FRAMEWORK_KEY] === true;
}
