import { existsSync, readFileSync, mkdirSync, openSync, writeSync, closeSync, writeFileSync, constants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { debuglog } from 'node:util';
import { CORE_VERSION } from '../version.js';
import { Scope } from '../common/index.js';
import { isTelemetryEnabled } from './consent.js';
import { collectEnvironment } from './environment.js';
import { getInstallationId, getProjectId, generateEventId } from './identifiers.js';
import { REPORTED_FRAMEWORKS } from './types.js';
import type { BlocksTelemetryEvent, BuildAndSendEventOptions, ReportedFramework } from './types.js';

// Debug log: writes to stderr via NODE_DEBUG=blocks-telemetry (developer-facing, for troubleshooting)
const debug = debuglog('blocks-telemetry');

const DEFAULT_ENDPOINT = 'https://blocks-telemetry.us-east-1.api.aws/metrics';
const TELEMETRY_VERSION = '1.0.0';

function isReportedFramework(name: string): name is ReportedFramework {
  return (REPORTED_FRAMEWORKS as readonly string[]).includes(name);
}

function getEndpoint(): string {
  return process.env.BLOCKS_TELEMETRY_ENDPOINT || DEFAULT_ENDPOINT;
}

/**
 * Parse `--telemetry-file=/path/to/file.json` from process.argv.
 *
 * Supports both `--telemetry-file=path` and `--telemetry-file path` forms.
 *
 * @returns The file path if the flag is present, undefined otherwise.
 *
 * @example
 * // Capture telemetry to file and send it, with telemetry enabled. The flag
 * // must reach the process that runs the dev server or deploy runner, e.g.
 * // through an app's npm script:
 * // npm run dev -- --telemetry-file=/tmp/events.json
 *
 * // Capture without sending — redirect the endpoint instead of opting out:
 * // BLOCKS_TELEMETRY_ENDPOINT=http://127.0.0.1:1 npm run dev -- \
 * //   --telemetry-file=/tmp/events.json
 */
export function getTelemetryFilePath(): string | undefined {
  const arg = process.argv.find(a => a.startsWith('--telemetry-file='));
  if (arg) {
    const p = arg.slice('--telemetry-file='.length);
    return p.trim() === '' ? undefined : p;
  }
  const idx = process.argv.indexOf('--telemetry-file');
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('-')) {
    const p = process.argv[idx + 1];
    return p.trim() === '' ? undefined : p;
  }
  return undefined;
}

const ownedTelemetryFiles = new Set<string>();

// File sink: writes to --telemetry-file path (user-facing, for debugging/testing)
function writeToTelemetryFile(event: BlocksTelemetryEvent): void {
  const filePath = getTelemetryFilePath();
  if (!filePath) return;

  try {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // O_CREAT | O_EXCL: atomic create — fails with EEXIST if file already exists
    const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    const content = JSON.stringify([event], null, 2);
    writeSync(fd, content);
    closeSync(fd);
    ownedTelemetryFiles.add(path.resolve(filePath));
  } catch (err: any) {
    // Appending only to a path this run created leaves a pre-existing file intact.
    if (err?.code === 'EEXIST' && ownedTelemetryFiles.has(path.resolve(filePath))) {
      appendToTelemetryFile(filePath, event);
    }
    // All other errors silently ignored — telemetry must never affect commands
  }
}

function appendToTelemetryFile(filePath: string, event: BlocksTelemetryEvent): void {
  try {
    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(events)) throw new Error('telemetry file is not a JSON array');
    events.push(event);
    writeFileSync(filePath, JSON.stringify(events, null, 2));
  } catch (err) {
    debug('failed to append telemetry event: %s', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Constructs a telemetry event without sending it.
 * Not side-effect free: it mints and persists the installation and project IDs and may
 * print the first-run notice, so callers must check consent first.
 * @internal
 */
export function buildEvent(opts: BuildAndSendEventOptions): BlocksTelemetryEvent {
  const { blocks, totalCount, customBlocksCount } = Scope.getRegisteredBlocks();

  let templateName: string | undefined = opts.product?.template;
  let templateVersion: string | undefined = opts.product?.templateVersion;
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.blocksTemplate) templateName = templateName || pkg.blocksTemplate;
      if (pkg.blocksTemplateVersion) templateVersion = templateVersion || pkg.blocksTemplateVersion;
    }
  } catch {
    // template info is best-effort
  }

  const buildingBlocks = blocks;

  const resolvedFramework = opts.product?.framework ?? Scope._getRegisteredFramework();
  const framework =
    resolvedFramework !== undefined && isReportedFramework(resolvedFramework) ? resolvedFramework : undefined;

  return {
    telemetryVersion: TELEMETRY_VERSION,
    identifiers: {
      installationId: getInstallationId(),
      projectId: getProjectId(),
      eventId: generateEventId(),
      timestamp: new Date().toISOString(),
    },
    event: {
      command: opts.command,
      state: opts.state,
      duration: opts.duration,
      ...(opts.error && { error: opts.error }),
    },
    environment: collectEnvironment(),
    product: {
      blocksVersion: CORE_VERSION,
      ...(opts.product?.cdkVersion && { cdkVersion: opts.product.cdkVersion }),
      ...(framework && { framework }),
      ...(templateName && {
        template: {
          name: templateName,
          ...(templateVersion && { version: templateVersion }),
        },
      }),
      ...(buildingBlocks.length > 0 && { buildingBlocks }),
    },
    ...(opts.counters || totalCount > 0 || customBlocksCount > 0
      ? {
          counters: {
            blocksCount: opts.counters?.blocksCount ?? totalCount,
            ...(opts.counters?.customBuildingBlocks !== undefined
              ? { customBuildingBlocks: opts.counters.customBuildingBlocks }
              : customBlocksCount > 0 ? { customBuildingBlocks: customBlocksCount } : undefined),
          },
        }
      : undefined),
  };
}

/**
 * Build a complete telemetry event and send it to the collection endpoint.
 *
 * This is the single entry point for all telemetry emission. It handles:
 * 1. Early exit — when telemetry is disabled: no identifiers persisted, no first-run
 *    notice, no file, no HTTP
 * 2. Full payload construction (identifiers, environment, product info)
 * 3. File sink — writes to the file specified by `--telemetry-file` (if set)
 * 4. Privacy filtering — custom BB names are NEVER sent, only counted
 * 5. HTTP sink — fire-and-forget POST
 *
 * Callers never need to import consent, identifier, or environment utilities directly.
 *
 * @param opts - Event metadata (command, state, duration, optional error/product/counters)
 *
 * @example
 * ```ts
 * buildAndSendEvent({
 *   command: 'deploy',
 *   state: 'SUCCESS',
 *   duration: 4500,
 *   product: { cdkVersion: '2.150.0' },
 * });
 * ```
 */
export function buildAndSendEvent(opts: BuildAndSendEventOptions): void {
  try {
    if (!isTelemetryEnabled()) return;

    const filePath = getTelemetryFilePath();
    const event = buildEvent(opts);

    if (filePath) writeToTelemetryFile(event);
    sendEvent(event);
  } catch {
    // Telemetry must never throw or affect the user's command
  }
}

/**
 * Send a pre-built telemetry event to the collection endpoint.
 *
 * Spawns a detached subprocess that performs the HTTPS POST independently of
 * the parent CLI process. This ensures the request completes even when the
 * parent exits on failure paths before an in-process request would flush.
 * Debug output available via `NODE_DEBUG=blocks-telemetry`.
 */
export function sendEvent(event: BlocksTelemetryEvent): void {
  try {
    const endpoint = getEndpoint();
    const payload = JSON.stringify(event);

    // E2E test sink: writes to BLOCKS_TELEMETRY_FILE env path (test-facing, for assertions)
    if (process.env.BLOCKS_TELEMETRY_FILE) {
      try { writeFileSync(process.env.BLOCKS_TELEMETRY_FILE, payload); } catch {}
    }

    debug('sending event to %s (%d bytes)', endpoint, Buffer.byteLength(payload));

    const dir = path.dirname(fileURLToPath(import.meta.url));
    const workerPath = path.join(dir, 'telemetry-send-worker.js');
    const child = spawn(process.execPath, [workerPath, endpoint], {
      detached: true,
      stdio: ['pipe', 'ignore', process.env.NODE_DEBUG?.includes('blocks-telemetry') ? 'inherit' : 'ignore'],
      // Clear NODE_OPTIONS so inherited flags (e.g. --conditions=cdk) don't interfere
      env: { ...process.env, NODE_OPTIONS: '' },
    });

    child.stdin?.on('error', (err) => { debug('stdin write failed: %s', err.message); });
    // Payload is small (<1KB JSON) so it fits in the kernel pipe buffer (~64KB)
    // and survives the parent closing its fd on exit.
    child.stdin?.write(payload);
    child.stdin?.end();
    child.on('error', (err) => { debug('spawn failed: %s', err.message); });
    child.unref();
    debug('spawned telemetry subprocess (pid=%d)', child.pid);
  } catch {
    // Telemetry must never throw or affect the user's command
  }
}
