// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export {
	type BuildAndSendEventOptions,
	buildAndSendEvent,
	type CommandName,
	type CommandState,
	classifyError,
	trackCommand,
} from '../telemetry/index.js';
export { listConfig, removeConfig, runConfigCli, setConfig } from './config.js';
export { type ConsoleOptions, openConsole } from './console.js';
export {
	DEFAULT_DASHBOARD_PORT,
	type DashboardArgs,
	type DashboardCommand,
	type DashboardOptions,
	buildDashboardUrl,
	dashboard,
	parseDashboardArgs,
} from './dashboard.js';
export { type DeployOptions, deploy } from './deploy.js';
export {
	DEPLOY_HISTORY_FILE,
	type DeployHistoryRecord,
	type DeployRecorder,
	appendDeployHistoryRecord,
	createDeployRecorder,
	getGitSha,
	summarizeError,
} from './deploy-history.js';
export { type DestroyOptions, destroy } from './destroy.js';
export {
	type DevServerOptions,
	type StopResult,
	runStopCli,
	startDevServer,
	stopDevServer,
	stopMessage,
} from './dev-server.js';
export { ensureSecrets, loadEnvFile, loadProductionEnv } from './ensure-secrets.js';
export { generateClientCode, writeClientCode } from './generate-client.js';
export { generateSpec, type SpecGenerationOptions, writeSpec } from './generate-spec.js';
export {
	NativeCatalogError,
	type NativeDeclarationInput,
	type NativeDeclarationSource,
} from './native-catalogs.js';
export { readNativeDeclarations } from './read-native-declarations.js';
export {
	NoFreePortError,
	type PortScanOptions,
	findFreePort,
	isPortFree,
} from './port-scan.js';
export {
	PROJECT_MARKER,
	type ProjectResolution,
	type ResolveProjectOptions,
	type ResolvedProject,
	isBlocksProject,
	resolveProject,
} from './project-discovery.js';
export { destroySandbox, type SandboxOptions, startSandbox } from './sandbox.js';
export { listSecrets, removeSecret, runSecretCli, setSecret } from './secret.js';
export { getSandboxId, getStackId, getStackName } from './stack-id.js';
export { type TelemetryOptions, telemetry } from './telemetry.js';
export { runTypegenCli } from './typegen.js';
export { type SpecValidationError, validateSpec } from './validate-spec.js';
