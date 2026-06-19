// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export { startDevServer, type DevServerOptions } from './dev-server.js';
export { startSandbox, destroySandbox, type SandboxOptions } from './sandbox.js';
export { generateClientCode, writeClientCode } from './generate-client.js';
export { generateSpec, writeSpec } from './generate-spec.js';
export { validateSpec, type SpecValidationError } from './validate-spec.js';
export { deploy, type DeployOptions } from './deploy.js';
export { destroy, type DestroyOptions } from './destroy.js';
export { openConsole, type ConsoleOptions } from './console.js';
export { loadProductionEnv, loadEnvFile, findConnectionString } from './ensure-secrets.js';
export { stageConnectionString, sweepOrphanStagingParams, STAGING_PARAM_PREFIX, STAGING_ENV_VAR, type StagedSecret } from './stage-secret.js';
export {
  trackCommand,
  buildAndSendEvent,
  classifyError,
  type CommandName,
  type CommandState,
  type BuildAndSendEventOptions,
} from '../telemetry/index.js';
export { telemetry, type TelemetryOptions } from './telemetry.js';
