// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public runtime seam for the `@aws-blocks/cli` package.
 *
 * This module re-exports the stable runtime primitives the standalone CLI
 * needs, so the CLI can own its command implementations while depending only
 * on core's PUBLIC API — never on `@aws-blocks/core/scripts`. It is a pure
 * re-export module with NO side effects and no self-invoke.
 *
 * This mirrors how `aws-cdk-lib` stays a library under the `cdk` bin and how
 * `@aws-amplify/backend-cli` consumes runtime packages rather than reaching
 * into their internals.
 */

export { matchRoute, lockRouteRegistry } from './raw-route.js';
export { registerBuiltinRoutes } from './builtin-routes.js';
export {
	parseRpcRequest,
	successResponse,
	errorResponseFromCatch,
	methodNotFoundResponse,
	type RpcParsedRequest,
	type RpcParseResult,
} from './rpc.js';
export { redactToJson } from './redact.js';
export { CORS_MAX_AGE } from './cors.js';
export { ApiError } from './errors.js';
export { BLOCKS_RPC_PREFIX, BLOCKS_SANDBOX_PREFIX } from './constants.js';
export { BLOCKS_SANDBOX_DIR } from './common/constants.js';
export { API_NAMESPACE_MARKER } from './api.js';
export { dbConnectionParameterName, extractDbRef } from './db-naming.js';
export { blocksSecretPrefix, blocksConfigPrefix } from './secret-naming.js';
export { getStackName, getStackId, getSandboxId } from './stack-id.js';
export { trackCommand, classifyError } from './telemetry/trackCommand.js';
export {
	getTelemetryStatus,
	getGlobalConfigPath,
	getProjectConfigPath,
	isTelemetryEnabled,
	type TelemetryStatus,
} from './telemetry/consent.js';
export { writeConfigTelemetry } from './telemetry/config-writer.js';
export { buildAndSendEvent } from './telemetry/client.js';
export { CORE_VERSION } from './version.js';
