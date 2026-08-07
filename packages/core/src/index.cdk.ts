// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export { ApiNamespace, type BlocksContext, type ApiHandler } from './api.js';
export { BLOCKS_RPC_PREFIX, BLOCKS_AUTH_PREFIX } from './constants.js';
export { ApiError, isBlocksError, hasAuthError, DEFAULT_API_ERROR_NAME } from './errors.js';
export { EventSourceMapping } from './lambda-handler.js';
export { BlocksStackProps } from './common/index.js';
export { registerSdkIdentifiers, getSdkIdentifiers, getAllSdkIdentifiers, _resetSdkRegistry } from './common/sdk-registry.js';
export { getConfig, getConfigSync, preloadConfig, loadConfigToProcessEnv, _resetConfigCache } from './common/config.js';
export { BlocksStack, Scope, SandboxDisableDeletionProtection, BlocksBackend, registerConfig, finalizeConfigRegistry, getConfigDeployment, synthGuard, DEFAULT_NODE_RUNTIME, type BlocksBackendProps } from './cdk/index.js';
export type {
  ComputeTarget,
  ComputeBindContext,
  ComputeBindResult,
  ComputeApiOrigin,
  ComputePrincipal,
} from './cdk/index.js';
export {
  Hosting,
  type HostingProps,
  type BlocksStackApi,
  type FrameworkType,
  type ComputeConfig,
  type HostingDomainConfig,
  type HostingWafConfig,
} from './hosting.js';
export {
  RawRoute,
  RawRouteErrors,
  type RawRouteOptions,
  type HttpMethod,
} from './raw-route.cdk.js';
export {
  registerRoute,
  matchRoute,
  getRegisteredRoutes,
  clearRouteRegistry,
  lockRouteRegistry,
  unlockRouteRegistry,
  type RegisteredRoute,
} from './raw-route.js';
export {
  Pipeline,
  DeployStage,
  __PIPELINE_STAGE_SCOPE__,
  type DeployStageProps,
  type BranchConfig,
  type PipelineProps,
  type PipelineSourceConfig,
  type PipelineSynthConfig,
  type PipelineStageConfig,
} from './pipeline/index.js';
