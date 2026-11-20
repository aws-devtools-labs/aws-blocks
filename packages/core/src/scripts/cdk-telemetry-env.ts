// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { isTelemetryEnabled } from '../telemetry/consent.js';
import { FRAMEWORK_SINK_ENV } from '../telemetry/framework-sink.js';
import { CORE_VERSION } from '../version.js';

/**
 * Build CDK CLI telemetry-related environment variables.
 *
 * When CDK Blocks telemetry is enabled, sets `CDK_CLI_USERAGENT` so the CDK CLI
 * attributes usage back to CDK Blocks. When telemetry is disabled (user opted out),
 * sets `CDK_DISABLE_CLI_TELEMETRY=1` to suppress CDK's own telemetry collection
 * and omits the user-agent string.
 *
 * Any opt-out does this, not only the environment variable, so a context-file
 * opt-out cannot leave the child disagreeing with the parent.
 *
 * @param command - The CDK Blocks command context (e.g. "sandbox", "production")
 * @param projectRoot - Where to look for the project's CDK config. Defaults to the
 * current directory, which is correct for the lifecycle commands: they run with the
 * project root as their working directory. Pass it explicitly from a caller that
 * does not.
 * @returns An object to spread into the child process `env`
 */
export function getCdkTelemetryEnv(command: string, projectRoot?: string): Record<string, string> {
  if (!isTelemetryEnabled(projectRoot)) {
    return { CDK_DISABLE_CLI_TELEMETRY: '1' };
  }
  return { CDK_CLI_USERAGENT: `aws-blocks/${CORE_VERSION}/${command}` };
}

/**
 * Build the framework-sink environment variable for the cdk child.
 *
 * Returns nothing when the user opted out, so an opted-out run never writes the
 * sink file: opting out must not persist telemetry data to disk.
 *
 * @param sinkPath - File the synth child writes the resolved framework to, or
 *   undefined when no sink directory could be created
 * @param projectRoot - Where to look for the project's CDK config, as
 * {@link getCdkTelemetryEnv} takes it
 * @returns An object to spread into the child process `env`
 */
export function getFrameworkSinkEnv(sinkPath: string | undefined, projectRoot?: string): Record<string, string> {
  if (!sinkPath || !isTelemetryEnabled(projectRoot)) {
    return {};
  }
  return { [FRAMEWORK_SINK_ENV]: sinkPath };
}
