import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ENV_VAR = 'AWS_BLOCKS_DISABLE_TELEMETRY';

/**
 * Whether an `AWS_BLOCKS_DISABLE_TELEMETRY` value means "disabled".
 */
export function isDisableValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

interface BlocksConfig {
  telemetry?: { enabled?: boolean };
  [key: string]: unknown;
}

/**
 * Read and parse a Blocks config file, returning null if it doesn't exist or is invalid.
 */
export function readConfigFile(configPath: string): BlocksConfig | null {
  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as BlocksConfig;
  } catch {
    return null;
  }
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
 * @param projectRoot - Optional project root directory (defaults to process.cwd())
 */
export function getTelemetryStatus(projectRoot?: string): TelemetryStatus {
  const envValue = process.env[ENV_VAR];
  const globalConfig = readConfigFile(getGlobalConfigPath());
  const projectConfig = readConfigFile(getProjectConfigPath(projectRoot));

  const globalEnabled = globalConfig?.telemetry?.enabled;
  const projectEnabled = projectConfig?.telemetry?.enabled;

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
 * Determine whether telemetry collection is enabled.
 *
 * Disable mechanisms (any one disables telemetry):
 * - `AWS_BLOCKS_DISABLE_TELEMETRY` env var set to `1`, `true`, or `yes` (case-insensitive, trimmed)
 * - `.blocks/config.json` → `telemetry.enabled: false` (per-project)
 * - `~/.blocks/config.json` → `telemetry.enabled: false` (global)
 *
 * Default: enabled (if no disable mechanism is active)
 *
 * Note: CI environments do NOT suppress telemetry. CI detection is used
 * only as metadata in the telemetry payload (environment.ci field).
 */
export function isTelemetryEnabled(): boolean {
  if (isDisableValue(process.env[ENV_VAR])) {
    return false;
  }

  // Per-project config
  try {
    const projectConfigPath = join(process.cwd(), '.blocks', 'config.json');
    const content = readFileSync(projectConfigPath, 'utf-8');
    const config: BlocksConfig = JSON.parse(content);
    if (config.telemetry?.enabled === false) {
      return false;
    }
    if (config.telemetry?.enabled === true) {
      return true;
    }
  } catch {
    // No project config or invalid JSON
  }

  // Global config
  try {
    const globalConfigPath = join(homedir(), '.blocks', 'config.json');
    const content = readFileSync(globalConfigPath, 'utf-8');
    const config: BlocksConfig = JSON.parse(content);
    if (config.telemetry?.enabled === false) {
      return false;
    }
    if (config.telemetry?.enabled === true) {
      return true;
    }
  } catch {
    // No global config or invalid JSON
  }

  // Default: enabled
  return true;
}
