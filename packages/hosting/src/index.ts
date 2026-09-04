// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-blocks/hosting` — the **CDK-free value API**: the two intent functions
 * (`secret()` → Secrets Manager, `config()` → SSM) and the runtime resolvers
 * (`getSecret`/`getConfig`). Safe to import from application/runtime code (SSR
 * routes, Lambda, the edge runtime) — it pulls in no CDK, no `fast-glob`, and no
 * `node:fs`.
 *
 * Build-time tooling lives elsewhere so it never enters a runtime bundle: the CDK
 * construct + resolution engine on `@aws-blocks/hosting/constructs`, and the CLI +
 * typegen engines on `@aws-blocks/hosting/scripts`.
 *
 * @module
 */

// Two intent functions (I1, Approach B): secret() → Secrets Manager, config() → SSM.
export {
	type ConfigValue,
	cacheTtlEnvVarName,
	config,
	DEFAULT_CONFIG_PARAMETER_PREFIX,
	DEFAULT_SECRET_PARAMETER_PREFIX,
	decodeManagedValue,
	defaultPrefixForKind,
	encodeManagedValue,
	envVarNameForKind,
	fallbackEnvVarName,
	isConfig,
	isManagedValue,
	isManagedValueJSON,
	isSecret,
	MANAGED_BRAND,
	MANAGED_VALUE_JSON_TAG,
	type ManagedValue,
	type ManagedValueJSON,
	type ManagedValueOptions,
	managedValueReplacer,
	managedValueReviver,
	type SecretStore,
	type SecretValue,
	secret,
	secretStoreLocator,
	type ValueKind,
} from './secret.js';
// Runtime resolvers — typed against the (typegen-augmented) key registries.
export {
	type ConfigKey,
	type ConfigValueOf,
	getConfig,
	getSecret,
	type HostingConfigRegistry,
	type HostingSecretRegistry,
	type SecretKey,
	type SecretValueOf,
} from './secret-runtime.js';
