// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Declare functions for infra (secret/config). The runtime getters
// (getSecret/getConfig) are imported from '@aws-blocks/hosting' — core's own
// getConfig (backend config loader, above) owns that name here.
export {
	type ConfigValue,
	config,
	DEFAULT_CONFIG_PARAMETER_PREFIX,
	DEFAULT_SECRET_PARAMETER_PREFIX,
	isConfig,
	isManagedValue,
	isSecret,
	type ManagedValue,
	type SecretValue,
	secret,
	type ValueKind,
} from '@aws-blocks/hosting';
export { type ApiHandler, ApiNamespace, type BlocksContext } from './api.js';
export {
	BlocksBackend,
	type BlocksBackendProps,
	type BlocksDefaults,
	BlocksPresets,
	BlocksStack,
	type BlocksThrottling,
	blocksNodejsBundling,
	type CoreBlocksBackendProps,
	type CoreBlocksStackProps,
	DEFAULT_NODE_RUNTIME,
	ensureApiGatewayAccount,
	finalizeConfigRegistry,
	registerConfig,
	SandboxDisableDeletionProtection,
	Scope,
	SHARED_HANDLER_TIMEOUT_SECONDS,
	synthGuard,
} from './cdk/index.js';
export { _resetConfigCache, getConfig, getConfigSync, loadConfigToProcessEnv, preloadConfig } from './common/config.js';
export { BlocksStackProps } from './common/index.js';
export {
	_resetSdkRegistry,
	getAllSdkIdentifiers,
	getSdkIdentifiers,
	registerSdkIdentifiers,
} from './common/sdk-registry.js';
export { BLOCKS_AUTH_PREFIX, BLOCKS_RPC_PREFIX } from './constants.js';
export { ApiError, blocksError, DEFAULT_API_ERROR_NAME, hasAuthError, isBlocksError } from './errors.js';
export {
	type BlocksStackApi,
	type ComputeConfig,
	type FrameworkType,
	Hosting,
	type HostingDomainConfig,
	type HostingProps,
	type HostingWafConfig,
} from './hosting.js';
export { EventSourceMapping } from './lambda-handler.js';
export {
	__PIPELINE_STAGE_SCOPE__,
	type BranchConfig,
	DeployStage,
	type DeployStageProps,
	Pipeline,
	type PipelineProps,
	type PipelineSourceConfig,
	type PipelineStageConfig,
	type PipelineSynthConfig,
} from './pipeline/index.js';
export {
	type HttpMethod,
	RawRoute,
	RawRouteErrors,
	type RawRouteOptions,
} from './raw-route.cdk.js';
export {
	clearRouteRegistry,
	getRegisteredRoutes,
	lockRouteRegistry,
	matchRoute,
	type RegisteredRoute,
	registerRoute,
	unlockRouteRegistry,
} from './raw-route.js';
export {
	BLOCKS_CONFIG_PARAMETER_PREFIX,
	BLOCKS_SECRET_PARAMETER_PREFIX,
	blocksConfigParameterName,
	blocksSecretParameterName,
} from './secret-naming.js';
