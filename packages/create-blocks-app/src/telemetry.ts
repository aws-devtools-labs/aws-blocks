// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight, self-contained telemetry for create-blocks-app.
 *
 * This avoids depending on @aws-blocks/core (whose postinstall scripts
 * require devDependencies that aren't available when installed from the registry).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, writeSync, closeSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';

const DEFAULT_ENDPOINT = 'https://blocks-telemetry.us-east-1.api.aws/metrics';
const TIMEOUT_MS = 500;
const TELEMETRY_VERSION = '1.0.0';

const blocksVersion: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
).version;

// ─── Consent ─────────────────────────────────────────────────────────────────

function isCI(): boolean {
  return !!(
    process.env.CI ||
    process.env.CONTINUOUS_INTEGRATION ||
    process.env.BUILD_NUMBER ||
    process.env.CODEBUILD_BUILD_ID ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.JENKINS_URL ||
    process.env.TF_BUILD ||
    process.env.BITBUCKET_BUILD_NUMBER ||
    process.env.BUILDKITE
  );
}

function isTelemetryEnabled(): boolean {
  if (process.env.AWS_BLOCKS_DISABLE_TELEMETRY === '1') return false;

  // Per-project config
  try {
    const projectConfigPath = join(process.cwd(), '.blocks', 'config.json');
    const config = JSON.parse(readFileSync(projectConfigPath, 'utf-8'));
    if (config.telemetry?.enabled === false) return false;
    if (config.telemetry?.enabled === true) return true;
  } catch { /* no config */ }

  // Global config
  try {
    const globalConfigPath = join(homedir(), '.blocks', 'config.json');
    const config = JSON.parse(readFileSync(globalConfigPath, 'utf-8'));
    if (config.telemetry?.enabled === false) return false;
    if (config.telemetry?.enabled === true) return true;
  } catch { /* no config */ }

  return true;
}

// ─── Identifiers ─────────────────────────────────────────────────────────────

const FIRST_RUN_NOTICE = `
AWS Blocks collects anonymous usage data to improve the product.
No customer content or PII is collected.
To disable: npx blocks-telemetry --disable (or export AWS_BLOCKS_DISABLE_TELEMETRY=1)
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
    return process.argv[idx + 1];
  }
  return undefined;
}

function writeToTelemetryFile(event: Record<string, unknown>): void {
  const filePath = getTelemetryFilePath();
  if (!filePath) return;  // getTelemetryFilePath already rejects empty/whitespace

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
  } catch (err: any) {
    // EEXIST = file already existed → skip (protects user data)
    // All other errors silently ignored — telemetry must never affect commands
  }
}

// ─── Send ────────────────────────────────────────────────────────────────────

function sendEvent(event: Record<string, unknown>): void {
  try {
    const endpoint = process.env.BLOCKS_TELEMETRY_ENDPOINT || DEFAULT_ENDPOINT;
    const payload = JSON.stringify(event);
    const url = new URL(endpoint);
    const isHttps = url.protocol === 'https:';
    const requestFn = isHttps ? httpsRequest : httpRequest;

    const req = requestFn(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? '443' : '80'),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => { res.resume(); },
    );

    req.on('error', () => { /* silently swallow */ });
    req.on('timeout', () => { req.destroy(); });
    req.write(payload);
    req.end();
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
 * If telemetry is disabled AND no `--telemetry-file` is set, the wrapped
 * function runs without any telemetry overhead or side effects (no IDs
 * persisted, no first-run notice).
 *
 * The file sink writes regardless of opt-out status (inspired by CDK CLI's --telemetry-file).
 * The HTTP sink is fire-and-forget with a 500ms timeout and respects consent —
 * it will never delay the command.
 */
export async function trackCommand(
  commandName: string,
  fn: () => Promise<void>,
  options?: TrackCommandOptions,
): Promise<void> {
  const filePath = getTelemetryFilePath();
  const enabled = isTelemetryEnabled();

  if (!filePath && !enabled) {
    return fn();
  }

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
    if (enabled) sendEvent(event);
  }
}
