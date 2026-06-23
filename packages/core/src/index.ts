// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export { ApiNamespace, type BlocksContext, type ApiHandler } from './api.js';
export { BLOCKS_RPC_PREFIX, BLOCKS_AUTH_PREFIX } from './constants.js';
export { ApiError, isBlocksError, hasAuthError, DEFAULT_API_ERROR_NAME } from './errors.js';
export { Scope, type ScopeOptions, type ScopeParent, type BuildingBlockMeta } from './common/index.js';
export { registerSdkIdentifiers, getSdkIdentifiers, getAllSdkIdentifiers, _resetSdkRegistry } from './common/sdk-registry.js';
export { getConfig, getConfigSync, preloadConfig, loadConfigToProcessEnv, _resetConfigCache } from './common/config.js';
export {
  registerRoute,
  matchRoute,
  getRegisteredRoutes,
  clearRouteRegistry,
  lockRouteRegistry,
  unlockRouteRegistry,
  RawRouteErrors,
  type RawRouteOptions,
  type HttpMethod,
  type RegisteredRoute,
} from './raw-route.js';
export { RawRoute } from './raw-route.mock.js';
export { buildAgentTools, type AgentToolProvider, type AgentToolProviderOptions, type MethodOverrides, type ToolMethodDef } from './agent-tools.js';
