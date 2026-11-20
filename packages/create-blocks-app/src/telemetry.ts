// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight, self-contained telemetry for create-blocks-app.
 *
 * This avoids depending on @aws-cdk-blocks/core (whose postinstall scripts
 * require devDependencies that aren't available when installed from the registry).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, writeSync, closeSync, constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';

/** The hidden folder's pre-rename name. Mirrored from `@aws-cdk-blocks/core`, which this package does not depend on. */
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
 * Keep behaviorally identical to packages/core/src/telemetry/cdk-consent.ts, which
 * packages/core/src/telemetry/cdk-consent-cases.test.json enforces for both copies.
 *
 * Mirrors the CDK CLI's `['true', '1'].includes(value ?? '')`, so the match is
 * case-sensitive and untrimmed, unlike the template-metadata variable.
 */
export function isCdkDisableEnvValue(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

/**
 * Keep behaviorally identical to packages/core/src/telemetry/cdk-consent.ts, which
 * packages/core/src/telemetry/cdk-consent-cases.test.json enforces for both copies.
 *
 * Mirrors the CDK CLI's `['false', false].includes(...)`, so only the JSON boolean
 * `false` and the string `'false'` disable it.
 */
export function isCdkDisableContextValue(value: unknown): boolean {
  return value === false || value === 'false';
}

/**
 * Keep behaviorally identical to packages/core/src/telemetry/cdk-consent.ts.
 *
 * Resolves CDK's `cli-telemetry` context value the way CDK does: the first config
 * file that has the key at all wins, so an enable in an earlier file shadows a
 * disable in a later one. `cdk.json` and `~/.cdk.json` carry it inside a `context`
 * element; the whole of `cdk.context.json` is a context bag, and that is where
 * `cdk cli-telemetry --disable` writes it.
 */
export function isCdkTelemetryDisabled(): boolean {
  // The two literals below are CDK_DISABLE_ENV_VAR and CDK_TELEMETRY_CONTEXT_KEY in
  // packages/core/src/telemetry/cdk-consent.ts, which this file cannot import.
  if (isCdkDisableEnvValue(process.env.CDK_DISABLE_CLI_TELEMETRY)) return true;

  const read = (path: string): Record<string, unknown> | undefined => {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return undefined;
    }
  };
  const contextElement = (path: string): Record<string, unknown> | undefined => {
    const context = read(path)?.context;
    return typeof context === 'object' && context !== null ? (context as Record<string, unknown>) : undefined;
  };

  // Core resolves first and classifies later; shared cases keep both implementations equivalent.
  for (const bag of [
    contextElement(join(process.cwd(), 'cdk.json')),
    read(join(process.cwd(), 'cdk.context.json')),
    contextElement(join(homedir(), '.cdk.json')),
  ]) {
    const value = bag?.['cli-telemetry'];
    if (value !== undefined) return isCdkDisableContextValue(value);
  }
  return false;
}

/**
 * Keep behaviorally identical to packages/core/src/telemetry/consent.ts.
 *
 * CDK Blocks has no opt-out of its own: consent is CDK's.
 *
 * Project-level CDK config in `process.cwd()` takes precedence over `~/.cdk.json`, so
 * scaffolding from inside an existing CDK project applies that project's setting.
 */
export function isTelemetryEnabled(): boolean {
  return !isCdkTelemetryDisabled();
}

// ─── Identifiers ─────────────────────────────────────────────────────────────

const FIRST_RUN_NOTICE = `
AWS CDK Blocks collects usage data to improve the product. Each event can include:
  random installation and project IDs, and an event ID and timestamp;
  the command, its outcome, duration and error category (never the error message);
  your OS, Node.js version and package manager user agent; whether it ran in CI or under a coding agent;
  the CDK Blocks and CDK versions, the framework, and the template name and version;
  the names and versions of the official Building Blocks the app uses, how many Building Blocks it uses,
  and how many of them are custom (custom Building Block names are never sent).
Events never include names, email addresses, AWS account IDs, ARNs, file paths, file contents or source code.
The collection endpoint also receives your IP address, as with any HTTPS request.
It is not stored, except in logs of requests that the endpoint's firewall blocks.
Events are kept for up to 1 year, and logs of all requests, blocked or not, for up to 10 years.
Telemetry follows your CDK CLI telemetry setting, and CDK Blocks has no separate opt-out.
To opt out of both, run cdk cli-telemetry --disable, or export CDK_DISABLE_CLI_TELEMETRY=1.
CDK documents those settings at
https://docs.aws.amazon.com/cdk/v2/guide/cli-telemetry.html#telemetry-opt-out
`;

function getInstallationId(): string {
  const filePath = join(homedir(), '.cdk-blocks', 'telemetry', 'installation-id');
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
    // swallow the rethrow above. No projectRoot: cwd is where a scaffold's CDK config sits.
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
