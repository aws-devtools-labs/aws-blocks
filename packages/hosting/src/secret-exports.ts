// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-free entry point for the secret API. The package's main `index.ts`
 * re-exports CDK constructs (`HostingConstruct`), so importing from it in a
 * runtime/local context would pull all of CDK. This subpath
 * (`@aws-blocks/hosting/secret`) exposes only the dependency-free marker and
 * the runtime resolver, so `@aws-blocks/core`'s runtime index can re-export
 * `secret()` / `getSecret()` without dragging CDK into the Lambda bundle.
 *
 * @module
 */

export {
	isSecret,
	SECRET_BRAND,
	SECRET_PARAMETER_PREFIX,
	type SecretOptions,
	type SecretValue,
	secret,
	secretEnvVarName,
	secretParameterName,
} from './secret.js';
export { _resetSecretCache, _setSecretFetcher, getSecret } from './secret-runtime.js';
