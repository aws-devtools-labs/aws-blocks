// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { isCdkTelemetryDisabled } from './cdk-consent.js';

/**
 * Whether telemetry may be collected.
 *
 * CDK Blocks has no opt-out of its own, so consent is CDK's and this is the
 * negation of {@link isCdkTelemetryDisabled} and nothing else:
 * https://docs.aws.amazon.com/cdk/v2/guide/cli-telemetry.html#telemetry-opt-out
 *
 * CI environments do NOT suppress telemetry — CI detection is carried as event
 * metadata (`environment.ci`) and is deliberately not consulted here.
 *
 * @param projectRoot - Directory holding the project's CDK config files. A bin that
 *   never chdirs to the project root must pass it, or a run from a subdirectory sees
 *   only `~/.cdk.json` and misses the project's own opt-out.
 */
export function isTelemetryEnabled(projectRoot?: string): boolean {
  return !isCdkTelemetryDisabled(projectRoot);
}
