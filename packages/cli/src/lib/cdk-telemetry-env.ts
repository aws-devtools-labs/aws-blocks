// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { isTelemetryEnabled } from '@aws-blocks/core/runtime';
import { CORE_VERSION } from '@aws-blocks/core/runtime';

/**
 * Build CDK CLI telemetry-related environment variables.
 *
 * When Blocks telemetry is enabled, sets `CDK_CLI_USERAGENT` so the CDK CLI
 * attributes usage back to Blocks. When telemetry is disabled (user opted out),
 * sets `CDK_DISABLE_CLI_TELEMETRY=1` to suppress CDK's own telemetry collection
 * and omits the user-agent string.
 *
 * @param command - The Blocks command context (e.g. "sandbox", "production")
 * @returns An object to spread into the child process `env`
 */
export function getCdkTelemetryEnv(command: string): Record<string, string> {
  if (!isTelemetryEnabled()) {
    return { CDK_DISABLE_CLI_TELEMETRY: '1' };
  }
  return { CDK_CLI_USERAGENT: `aws-blocks/${CORE_VERSION}/${command}` };
}
