// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-free entry point for the secret API (`@aws-blocks/hosting/secret`).
 *
 * The package's main `index.ts` re-exports CDK constructs, so importing from it
 * in a runtime/CLI context would pull all of CDK. This subpath exposes only the
 * dependency-free marker, the runtime resolver, and the set/list/remove CLI
 * core — so consumers (core's runtime index, a standalone `npm run secret`
 * wrapper, Amplify's `ampx hosting secret`) can use them without dragging CDK
 * into the Lambda bundle or a CLI process.
 *
 * @module
 */

export {
	DEFAULT_SECRET_PARAMETER_PREFIX,
	DEFAULT_SECRET_STORE,
	isSecret,
	SECRET_BRAND,
	type SecretOptions,
	type SecretStore,
	type SecretValue,
	secret,
	secretEnvVarName,
	secretFallbackEnvVarName,
	secretParameterName,
	secretStoreLocator,
} from './secret.js';
export {
	listSecrets,
	removeSecret,
	runSecretCli,
	type SecretCliOptions,
	setSecret,
} from './secret-cli.js';
export { _resetSecretCache, _setSecretFetcher, getSecret } from './secret-runtime.js';
