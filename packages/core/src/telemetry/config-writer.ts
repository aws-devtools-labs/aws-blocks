// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { updateBlocksConfigFile } from '../blocks-config-file.js';

/** How long `blocks-telemetry --enable/--disable` waits for another writer of the config. */
const TELEMETRY_SETTING_LOCK_TIMEOUT_MS = 5_000;

/**
 * Read an existing config file, merge the telemetry.enabled setting, and write it back.
 * Creates the file and parent directories if they don't exist.
 * Preserves all other keys in the config file and in the telemetry object
 * (e.g., projectId, and the project's `stackId`).
 *
 * The read-modify-write runs under the config's exclusive lock (`<config>.lock`)
 * and replaces the file atomically (temp file + rename), so concurrent writers never
 * leave a truncated file or drop or undo each other's keys. A UTF-8 BOM is tolerated.
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
 * @throws If another writer holds the lock for longer than 5 s; nothing is written.
 */
export function writeConfigTelemetry(configPath: string, telemetryEnabled: boolean): void {
  updateBlocksConfigFile(configPath, (config) => {
    const existing = config.telemetry;
    const telemetry = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    config.telemetry = { ...telemetry, enabled: telemetryEnabled };
    return true;
  }, { lockTimeoutMs: TELEMETRY_SETTING_LOCK_TIMEOUT_MS });
}
