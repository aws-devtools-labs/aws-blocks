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
  | 'vendorize';

/**
 * Terminal state of a command execution.
 */
export type CommandState = 'SUCCESS' | 'FAIL' | 'ABORTED';

/**
 * The server validates `product.framework` against this enum with
 * `additionalProperties: false`, so an out-of-enum value costs the whole event.
 */
export const REPORTED_FRAMEWORKS = ['nextjs', 'nitro', 'nuxt', 'astro', 'sveltekit', 'spa', 'static'] as const;
export type ReportedFramework = (typeof REPORTED_FRAMEWORKS)[number];

/**
 * The telemetry event payload sent to the endpoint.
 *
 * Matches the server schema exactly (additionalProperties: false).
 *
 * The identifiers are random UUIDs (not derived from the machine, user or AWS
 * account), errors are reported as a fixed `code`/`phase` category (never the
 * message or a stack), `environment.packageManager` is the raw
 * `npm_config_user_agent` string, and only official Building Block names are
 * sent (custom ones are only counted). The payload never carries names, email
 * addresses, AWS account IDs, ARNs, file paths, file contents or source code.
 * As with any HTTPS request, the collection endpoint also receives the
 * client's IP address.
 * The service does not store it, except in logs of requests its firewall
 * blocks. Events are kept for up to 1 year, and request logs for up to
 * 10 years.
 * Keep the first-run notice (`FIRST_RUN_NOTICE` in `identifiers.ts` and in
 * `create-blocks-app`'s `telemetry.ts`) and the `@aws-blocks/blocks` README in
 * sync with this list.
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
    framework?: ReportedFramework;
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
  framework?: ReportedFramework;
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
    framework?: ReportedFramework;
    template?: string;
    templateVersion?: string;
  };
  counters?: { blocksCount: number; customBuildingBlocks?: number };
}
