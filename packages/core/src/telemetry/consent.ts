import { join } from 'node:path';
import { homedir } from 'node:os';
import { readBlocksConfigFile } from '../blocks-config-file.js';

const ENV_VAR = 'AWS_BLOCKS_DISABLE_TELEMETRY';

/**
 * Whether an `AWS_BLOCKS_DISABLE_TELEMETRY` value means "disabled".
 */
export function isDisableValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Get the path to the global Blocks config file (~/.blocks/config.json).
 */
export function getGlobalConfigPath(): string {
  return join(homedir(), '.blocks', 'config.json');
}

/**
 * Get the path to the project-level Blocks config file (.blocks/config.json).
 *
 * @param projectRoot - Optional project root directory (defaults to process.cwd())
 */
export function getProjectConfigPath(projectRoot?: string): string {
  return join(projectRoot ?? process.cwd(), '.blocks', 'config.json');
}

/**
 * `telemetry.enabled` from a Blocks config file, or `undefined` when the file is
 * missing, unparseable, or doesn't set it (a UTF-8 BOM is tolerated).
 */
function readTelemetryEnabled(configPath: string): unknown {
  const read = readBlocksConfigFile(configPath);
  if (read.status !== 'ok') return undefined;
  const telemetry = read.config.telemetry;
  return telemetry && typeof telemetry === 'object' && 'enabled' in telemetry ? telemetry.enabled : undefined;
}

/**
 * Result of a detailed telemetry status check.
 */
export interface TelemetryStatus {
  /** Whether telemetry is currently enabled (final resolved value). */
  enabled: boolean;
  /** Value of AWS_BLOCKS_DISABLE_TELEMETRY env var if set. */
  envVar?: string;
  /** Value from global config if present. */
  globalConfig?: boolean;
  /** Value from project config if present. */
  projectConfig?: boolean;
}

/**
 * Get detailed telemetry status showing all mechanism values and the final result.
 *
 * Telemetry is enabled by default. If any mechanism disables it, telemetry is off:
 * - `AWS_BLOCKS_DISABLE_TELEMETRY` env var set to `1`, `true`, or `yes` (case-insensitive, trimmed)
 * - `.blocks/config.json` → `telemetry.enabled: false` (per-project)
 * - `~/.blocks/config.json` → `telemetry.enabled: false` (global)
 *
 * `telemetry.enabled: true` only expresses "no objection from this file"; it never
 * overrides another mechanism's disable. There is deliberately no `=== true` branch.
 *
 * CI environments do NOT suppress telemetry — CI detection is carried as event
 * metadata (`environment.ci`) and is deliberately not consulted here.
 *
 * @param projectRoot - Optional project root directory (defaults to process.cwd())
 */
export function getTelemetryStatus(projectRoot?: string): TelemetryStatus {
  const envValue = process.env[ENV_VAR];
  const globalEnabled = readTelemetryEnabled(getGlobalConfigPath());
  const projectEnabled = readTelemetryEnabled(getProjectConfigPath(projectRoot));

  const status: TelemetryStatus = {
    enabled: true,
  };

  if (envValue !== undefined && envValue !== '') {
    status.envVar = envValue;
  }
  if (typeof globalEnabled === 'boolean') {
    status.globalConfig = globalEnabled;
  }
  if (typeof projectEnabled === 'boolean') {
    status.projectConfig = projectEnabled;
  }

  if (isDisableValue(envValue)) {
    status.enabled = false;
    return status;
  }

  if (status.projectConfig === false) {
    status.enabled = false;
    return status;
  }

  if (status.globalConfig === false) {
    status.enabled = false;
    return status;
  }

  return status;
}

/**
 * A second copy of the precedence rule is what let a project `telemetry.enabled: true`
 * re-enable a global opt-out, so the two config files are resolved only by
 * {@link getTelemetryStatus}. Keep it that way.
 *
 * The env var is checked first so an opted-out command reads no config file at all
 * (design tenet: when disabled, zero overhead). It is not part of the precedence
 * question — it outranks both files in `getTelemetryStatus` too, so the short-circuit
 * cannot disagree with it.
 */
export function isTelemetryEnabled(): boolean {
  if (isDisableValue(process.env[ENV_VAR])) {
    return false;
  }
  return getTelemetryStatus().enabled;
}
