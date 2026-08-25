// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-blocks/hosting` — the **CDK-free value API**: the two intent functions
 * (`secret()` → Secrets Manager, `config()` → SSM), the runtime resolvers
 * (`getSecret`/`getConfig`), the shared CLI core, and the typegen engine. Safe to
 * import from application/runtime code (SSR routes, Lambda) — it pulls in no CDK.
 *
 * The CDK construct and the resolution engine live on the `/constructs` subpath
 * ({@link file://./constructs/index.ts}); the runtime getters are re-exported from
 * there too via that module's imports, but application code only ever needs this
 * entry and `/constructs`.
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
	defaultPrefixForKind,
	envVarNameForKind,
	fallbackEnvVarName,
	isConfig,
	isManagedValue,
	isSecret,
	MANAGED_BRAND,
	type ManagedValue,
	type ManagedValueOptions,
	type SecretStore,
	type SecretValue,
	secret,
	secretStoreLocator,
	type ValueKind,
} from './secret.js';
// Shared CLI core (secret/config × set/list/remove) — consumers wrap with a fixed kind + label/prefix.
export {
	listValues,
	removeValue,
	runValueCli,
	setValue,
	type ValueCliOptions,
} from './secret-cli.js';
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
// Typegen engine (drives `hosting-typegen`).
export {
	DEFAULT_MARKER_MODULES,
	DEFAULT_TYPEGEN_INCLUDE,
	DEFAULT_TYPEGEN_MODULE,
	DEFAULT_TYPEGEN_MODULES,
	DEFAULT_TYPEGEN_OUT,
	type DynamicCallSite,
	type GenerateOptions,
	generateHostingValuesDts,
	renderHostingValuesDts,
	runTypegenCli,
	type ScanResult,
	scanValueKeys,
	type TypegenCliDeps,
	type TypegenOptions,
	type TypegenResult,
	type WatchOptions,
	watchHostingValues,
} from './secret-typegen.js';
