// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// secret()/config() declare markers (CDK-free subpath). The runtime getters
// getSecret()/getConfig() are imported from '@aws-blocks/hosting' directly —
// core already exports a backend `getConfig` (config loader) under this name.
export {
	type ConfigValue,
	config,
	configEnvVarName,
	isConfig,
	isManagedValue,
	isSecret,
	type ManagedValue,
	parameterName,
	type SecretValue,
	secret,
	secretEnvVarName,
	storeForKind,
	type ValueKind,
} from '@aws-blocks/hosting/secret';
export { type ApiHandler, ApiNamespace, type BlocksContext } from './api.js';
export { _resetConfigCache, getConfig, getConfigSync, loadConfigToProcessEnv, preloadConfig } from './common/config.js';
export { type BuildingBlockMeta, Scope, type ScopeOptions, type ScopeParent } from './common/index.js';
export {
	_resetSdkRegistry,
	getAllSdkIdentifiers,
	getSdkIdentifiers,
	registerSdkIdentifiers,
} from './common/sdk-registry.js';
export { BLOCKS_AUTH_PREFIX, BLOCKS_RPC_PREFIX } from './constants.js';
export { ApiError, DEFAULT_API_ERROR_NAME, hasAuthError, isBlocksError } from './errors.js';
export {
	clearRouteRegistry,
	getRegisteredRoutes,
	type HttpMethod,
	lockRouteRegistry,
	matchRoute,
	RawRouteErrors,
	type RawRouteOptions,
	type RegisteredRoute,
	registerRoute,
	unlockRouteRegistry,
} from './raw-route.js';
export { RawRoute } from './raw-route.mock.js';
