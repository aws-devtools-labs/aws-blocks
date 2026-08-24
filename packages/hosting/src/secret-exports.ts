// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-free entry point for the value API (`@aws-blocks/hosting/secret`).
 *
 * The package's main `index.ts` re-exports CDK constructs, so importing from it
 * in a runtime/CLI context would pull all of CDK. This subpath exposes only the
 * dependency-free markers (`secret`/`config`), the runtime resolvers
 * (`getSecret`/`getConfig`), and the set/list/remove CLI core — usable without
 * dragging CDK into the Lambda bundle or a CLI process.
 *
 * @module
 */

export {
	type ConfigValue,
	cacheTtlEnvVarName,
	config,
	configEnvVarName,
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
	parameterName,
	type SecretStore,
	type SecretValue,
	secret,
	secretEnvVarName,
	secretStoreLocator,
	storeForKind,
	type ValueKind,
} from './secret.js';
export {
	listValues,
	removeValue,
	runValueCli,
	setValue,
	type ValueCliOptions,
} from './secret-cli.js';
export {
	_resetSecretCache,
	_setSecretFetcher,
	type ConfigKey,
	getConfig,
	getSecret,
	type HostingConfigRegistry,
	type HostingSecretRegistry,
	type SecretKey,
} from './secret-runtime.js';
export {
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
