/**
 * Command names tracked by the Blocks CLI telemetry system.
 */
export type CommandName =
  | 'create-blocks-app'
  | 'dev'
  | 'sandbox'
  | 'sandbox:destroy'
  | 'deploy'
  | 'destroy'
  | 'cleanup'
  | 'console'
  | 'dashboard'
  | 'vendorize';

/**
 * Terminal state of a command execution.
 */
export type CommandState = 'SUCCESS' | 'FAIL' | 'ABORTED';

/**
 * The telemetry event payload sent to the endpoint.
 *
 * Matches the server schema exactly (additionalProperties: false).
 * All fields are anonymized — no PII, no customer content, no account IDs.
 */
export interface BlocksTelemetryEvent {
  telemetryVersion: string;
  identifiers: {
    installationId: string;
    projectId: string;
    eventId: string;
    timestamp: string;
  };
  event: {
    command: CommandName;
    state: CommandState;
    duration: number;
    error?: {
      code: string;
      phase: string;
    };
  };
  environment: {
    os: 'linux' | 'darwin' | 'win32';
    nodeVersion: string;
    ci: boolean;
    packageManager?: string;
    agent?: string;
  };
  product?: {
    blocksVersion: string;
    cdkVersion?: string;
    framework?: 'nextjs' | 'spa' | 'static';
    template?: { name: string; version?: string };
    buildingBlocks?: Array<{ name: string; version: string }>;
  };
  counters?: {
    blocksCount: number;
    customBuildingBlocks?: number;
  };
}

/**
 * Options for the `trackCommand` utility.
 */
export interface TrackCommandOptions {
  template?: string;
  templateVersion?: string;
  framework?: 'nextjs' | 'spa' | 'static';
  cdkVersion?: string;
  blocksCount?: number;
}

/**
 * Options accepted by `buildAndSendEvent()`.
 *
 * Callers provide minimal metadata; the function resolves identifiers,
 * environment, and consent internally.
 */
export interface BuildAndSendEventOptions {
  command: CommandName;
  state: CommandState;
  duration: number;
  error?: { code: string; phase: string };
  product?: {
    cdkVersion?: string;
    framework?: 'nextjs' | 'spa' | 'static';
    template?: string;
    templateVersion?: string;
  };
  counters?: { blocksCount: number; customBuildingBlocks?: number };
}
