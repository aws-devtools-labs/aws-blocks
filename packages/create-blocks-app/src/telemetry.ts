// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight, self-contained telemetry for create-blocks-app.
 *
 * This avoids depending on @aws-blocks/core (whose postinstall scripts
 * require devDependencies that aren't available when installed from the registry).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, writeSync, closeSync, constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { debuglog } from 'node:util';

import { isCI as ciInfoIsCI } from 'ci-info';

const debug = debuglog('blocks-telemetry');

const DEFAULT_ENDPOINT = 'https://blocks-telemetry.us-east-1.api.aws/metrics';
const TELEMETRY_VERSION = '1.0.0';

const blocksVersion: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
).version;

// ─── Consent ─────────────────────────────────────────────────────────────────

// Keep behaviorally identical to packages/core/src/telemetry/environment.ts.

// Checked by the previous implementation; ci-info does not match these alone.
const EXTRA_CI_ENV_VARS = ['CODEBUILD_BUILD_ID', 'JENKINS_URL', 'BITBUCKET_BUILD_NUMBER', 'TASKCLUSTER_ROOT_URL'];

/** ci-info result (fixed at import) OR per-call extra checks; `CI=false` at startup disables both. */
export function isCI(): boolean {
  if (ciInfoIsCI) return true;
  const env = process.env;
  if (env.CI === 'false') return false;
  return EXTRA_CI_ENV_VARS.some((key) => !!env[key]);
}

/**
 * Whether an `AWS_BLOCKS_DISABLE_TELEMETRY` value means "disabled".
 *
 * Keep behaviorally identical to packages/core/src/telemetry/consent.ts.
 */
export function isDisableValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Keep behaviorally identical to packages/core/src/telemetry/consent.ts.
 *
 * `telemetry.enabled: true` only expresses "no objection from this file"; it never
 * overrides another mechanism's disable. There is deliberately no `=== true` branch.
 */
export function isTelemetryEnabled(): boolean {
  if (isDisableValue(process.env.AWS_BLOCKS_DISABLE_TELEMETRY)) return false;

  try {
    const projectConfigPath = join(process.cwd(), '.blocks', 'config.json');
    const config = JSON.parse(readFileSync(projectConfigPath, 'utf-8'));
    if (config.telemetry?.enabled === false) return false;
  } catch { /* no config */ }

  try {
    const globalConfigPath = join(homedir(), '.blocks', 'config.json');
    const config = JSON.parse(readFileSync(globalConfigPath, 'utf-8'));
    if (config.telemetry?.enabled === false) return false;
  } catch { /* no config */ }

  return true;
}

// ─── Identifiers ─────────────────────────────────────────────────────────────

const FIRST_RUN_NOTICE = `
AWS Blocks collects anonymous usage data to improve the product.
No customer content or PII is collected.
To disable: npx blocks-telemetry --disable (or export AWS_BLOCKS_DISABLE_TELEMETRY=1)
The env var accepts 1, true, or yes (case-insensitive).
`;

function getInstallationId(): string {
  const filePath = join(homedir(), '.blocks', 'telemetry', 'installation-id');
  try {
    const existing = readFileSync(filePath, 'utf-8').trim();
    if (existing) return existing;
  } catch { /* not created yet */ }

  const id = randomUUID();
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, id, 'utf-8');
  } catch { /* best-effort persist */ }
  process.stderr.write(FIRST_RUN_NOTICE + '\n');
  return id;
}

// ─── Environment ─────────────────────────────────────────────────────────────

function collectEnvironment(): {
  os: string;
  nodeVersion: string;
  ci: boolean;
  packageManager?: string;
} {
  const env: {
    os: string;
    nodeVersion: string;
    ci: boolean;
    packageManager?: string;
  } = {
    os: platform(),
    nodeVersion: process.versions.node,
    ci: isCI(),
  };
  if (process.env.npm_config_user_agent) {
    env.packageManager = process.env.npm_config_user_agent;
  }
  return env;
}

// ─── Error classification ────────────────────────────────────────────────────

function classifyError(error: unknown): { code: string; phase: string } {
  if (!(error instanceof Error)) return { code: 'UNKNOWN', phase: 'unknown' };
  const msg = error.message.toLowerCase();

  if (msg.includes('template') && msg.includes('copy')) return { code: 'TEMPLATE_COPY_FAILED', phase: 'init' };
  if (msg.includes('npm install') || msg.includes('npm err')) return { code: 'NPM_INSTALL_FAILED', phase: 'install' };
  if (msg.includes('argument') || msg.includes('parse')) return { code: 'ARG_PARSE_FAILED', phase: 'init' };
  return { code: 'UNKNOWN', phase: 'unknown' };
}

// ─── Telemetry File Sink ─────────────────────────────────────────────────────

/**
 * Parse `--telemetry-file=/path/to/file.json` from process.argv.
 *
 * Supports both `--telemetry-file=path` and `--telemetry-file path` forms.
 *
 * @returns The file path if the flag is present, undefined otherwise.
 */
export function getTelemetryFilePath(): string | undefined {
  const arg = process.argv.find(a => a.startsWith('--telemetry-file='));
  if (arg) {
    const path = arg.slice('--telemetry-file='.length);
    return path.trim() === '' ? undefined : path;
  }
  const idx = process.argv.indexOf('--telemetry-file');
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('-')) {
    const path = process.argv[idx + 1];
    return path.trim() === '' ? undefined : path;
  }
  return undefined;
}

const ownedTelemetryFiles = new Set<string>();

function writeToTelemetryFile(event: Record<string, unknown>): void {
  const filePath = getTelemetryFilePath();
  if (!filePath) return;

  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // O_CREAT | O_EXCL: atomic create — fails with EEXIST if file already exists
    const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    const content = JSON.stringify([event], null, 2);
    writeSync(fd, content);
    closeSync(fd);
    ownedTelemetryFiles.add(resolve(filePath));
  } catch (err: any) {
    // Appending only to a path this run created leaves a pre-existing file intact.
    if (err?.code === 'EEXIST' && ownedTelemetryFiles.has(resolve(filePath))) {
      appendToTelemetryFile(filePath, event);
    }
    // All other errors silently ignored — telemetry must never affect commands
  }
}

function appendToTelemetryFile(filePath: string, event: Record<string, unknown>): void {
  try {
    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(events)) throw new Error('telemetry file is not a JSON array');
    events.push(event);
    writeFileSync(filePath, JSON.stringify(events, null, 2));
  } catch (err) {
    debug('failed to append telemetry event: %s', err instanceof Error ? err.message : String(err));
  }
}

// ─── Send ────────────────────────────────────────────────────────────────────

function sendEvent(event: Record<string, unknown>): void {
  try {
    const endpoint = process.env.BLOCKS_TELEMETRY_ENDPOINT || DEFAULT_ENDPOINT;
    const payload = JSON.stringify(event);

    debug('sending event to %s (%d bytes)', endpoint, Buffer.byteLength(payload));

    const dir = dirname(fileURLToPath(import.meta.url));
    const workerPath = join(dir, 'telemetry-send-worker.js');
    const child = spawn(process.execPath, [workerPath, endpoint], {
      detached: true,
      stdio: ['pipe', 'ignore', process.env.NODE_DEBUG?.includes('blocks-telemetry') ? 'inherit' : 'ignore'],
      // Clear NODE_OPTIONS so inherited flags don't interfere
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
  } catch { /* telemetry must never throw */ }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface TrackCommandOptions {
  template?: string;
  templateVersion?: string;
}

/**
 * Wrap a CLI command with telemetry tracking.
 *
 * Measures wall-clock duration, classifies errors, and sends a single telemetry
 * event after the command completes (success or failure).
 *
 * If telemetry is disabled, the wrapped function runs with no telemetry side effects: no
 * installation ID persisted, no first-run notice, no file, no HTTP.
 *
 * When enabled, the file sink writes to `--telemetry-file` (if set) and the HTTP sink is
 * detached and unref'd, so the command does not wait for it.
 */
export async function trackCommand(
  commandName: string,
  fn: () => Promise<void>,
  options?: TrackCommandOptions,
): Promise<void> {
  if (!isTelemetryEnabled()) {
    return fn();
  }

  const filePath = getTelemetryFilePath();

  const startTime = Date.now();
  let state: 'SUCCESS' | 'FAIL' = 'SUCCESS';
  let errorInfo: { code: string; phase: string } | undefined;

  try {
    await fn();
  } catch (error: unknown) {
    state = 'FAIL';
    errorInfo = classifyError(error);
    throw error;
  } finally {
    // Re-read consent: an opt-out can land while fn() runs. A bare `return` here would
    // swallow the rethrow above.
    if (isTelemetryEnabled()) {
      const duration = Date.now() - startTime;

      const event = {
        telemetryVersion: TELEMETRY_VERSION,
        identifiers: {
          installationId: getInstallationId(),
          projectId: randomUUID(), // new project each time
          eventId: randomUUID(),
          timestamp: new Date().toISOString(),
        },
        event: {
          command: commandName,
          state,
          duration,
          ...(errorInfo && { error: errorInfo }),
        },
        environment: collectEnvironment(),
        product: {
          blocksVersion,
          ...(options?.template && { template: { name: options.template, ...(options.templateVersion && { version: options.templateVersion }) } }),
        },
      };

      if (filePath) writeToTelemetryFile(event);
      sendEvent(event);
    }
  }
}
