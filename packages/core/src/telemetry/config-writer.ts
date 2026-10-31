// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { updateBlocksConfigFile } from '../blocks-config-file.js';

/**
 * Read an existing config file, merge the telemetry.enabled setting, and write it back.
 * Creates the file and parent directories if they don't exist.
 * Preserves all other keys in the config file and in the telemetry object
 * (e.g., projectId, and the project's `stackId`).
 *
 * The file is re-read immediately before the write and replaced atomically (temp
 * file + rename), so concurrent writers never leave a truncated file or drop each
 * other's keys. A UTF-8 BOM is tolerated.
 *
 * Config format:
 * ```json
 * { "telemetry": { "enabled": true, "projectId": "..." } }
 * ```
 *
 * @param configPath - Absolute path to the config file
 * @param telemetryEnabled - Whether telemetry should be enabled
 * @throws If the existing file can't be parsed or isn't a JSON object. The file is
 *   left unchanged rather than replaced, so a committed `stackId` is never lost.
 */
export function writeConfigTelemetry(configPath: string, telemetryEnabled: boolean): void {
  updateBlocksConfigFile(configPath, (config) => {
    const existing = config.telemetry;
    const telemetry = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    config.telemetry = { ...telemetry, enabled: telemetryEnabled };
    return true;
  });
}
