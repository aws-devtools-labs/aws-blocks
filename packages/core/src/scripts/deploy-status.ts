// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { BLOCKS_DEPLOY_FAILED_LINE, BLOCKS_DEPLOYED_PREFIX } from '../common/constants.js';

// Reader for the deploy log a backgrounded `npm run deploy > deploy.log 2>&1 &`
// writes. `deploy()` already emits two stable terminal lines on stdout — the
// success signal (`BLOCKS_DEPLOYED url=… api=…`) and the failure banner
// (`❌ Deployment failed.`) — so a caller can tell "done + where it lives" from
// "failed" from "still running" without parsing CloudFormation or polling the
// stack. This module turns those lines into a one-call status read and a
// blocking wait, so an agent fires the deploy once and never falls back to
// `describe-stacks` polling.

/** The three states a deploy log can be in. */
export type DeployState = 'running' | 'deployed' | 'failed';

export interface DeployStatus {
  state: DeployState;
  /** Public frontend URL, present only once `deployed` and the app has hosting. */
  url?: string;
  /** Backend API URL, present only once `deployed`. */
  api?: string;
}

/**
 * Parse the deploy log text into a status. Pure so it is unit-tested directly
 * against real deploy output without running a deploy.
 *
 * A failed deploy that is then re-run appends to the same log, so the LAST
 * terminal line wins: a trailing `BLOCKS_DEPLOYED` means the latest attempt
 * succeeded even if an earlier `❌ Deployment failed.` is still in the file, and
 * vice-versa. A log with neither terminal line (or an empty/absent one) is
 * still `running`.
 */
export function parseDeployStatus(logText: string): DeployStatus {
  let last: DeployStatus = { state: 'running' };
  // Scan forward and keep the most recent terminal line, so a re-run's verdict
  // supersedes an earlier attempt's.
  for (const line of logText.split('\n')) {
    const signal = parseDeploySignalLine(line);
    if (signal) {
      last = signal;
    } else if (line.trimStart().startsWith(BLOCKS_DEPLOY_FAILED_LINE)) {
      // Anchor the banner at the (trimmed) line start, mirroring the success
      // path's api= guard, so a CDK/app log that merely quotes the sentence in
      // prose is not misread as a terminal failure. trimStart (not an exact
      // match) still tolerates a leading spinner/timestamp fragment.
      last = { state: 'failed' };
    }
  }
  return last;
}

/**
 * Parse a single line as the `BLOCKS_DEPLOYED url=… api=…` success signal, or
 * `null` if it is not that line. The two URLs are whitespace-delimited
 * `key=value` tokens; `url=` is absent for a backend-only (no-hosting) deploy,
 * mirroring {@link formatDeploySignal}.
 */
function parseDeploySignalLine(line: string): DeployStatus | null {
  const idx = line.indexOf(BLOCKS_DEPLOYED_PREFIX);
  if (idx === -1) return null;
  const rest = line.slice(idx + BLOCKS_DEPLOYED_PREFIX.length);
  const url = /\burl=(\S+)/.exec(rest)?.[1];
  const api = /\bapi=(\S+)/.exec(rest)?.[1];
  // A line that mentions the prefix in prose (not the actual signal) has no
  // api= token — treat it as not-a-signal rather than a malformed success.
  if (!api) return null;
  return url ? { state: 'deployed', url, api } : { state: 'deployed', api };
}

/** Human-readable, greppable one-liner for a status (what the CLI prints). */
export function formatDeployStatus(status: DeployStatus): string {
  switch (status.state) {
    case 'deployed':
      return status.url
        ? `✅ deployed url=${status.url} api=${status.api}`
        : `✅ deployed api=${status.api}`;
    case 'failed':
      return '❌ failed';
    case 'running':
      return '⏳ running';
  }
}

/** Read a deploy log file and return its status; a missing file is `running`. */
export function readDeployStatus(logPath: string): DeployStatus {
  let text: string;
  try {
    text = readFileSync(logPath, 'utf-8');
  } catch {
    // No log yet (deploy not started, or started but has not written a line) is
    // indistinguishable from an in-flight deploy to a reader — both are
    // "nothing terminal yet", which is `running`.
    return { state: 'running' };
  }
  return parseDeployStatus(text);
}

export interface DeployStatusCliOptions {
  /** Path to the deploy log (default `deploy.log` in the cwd). */
  logPath?: string;
  /** Injected for tests. */
  stdout?: { write(chunk: string): unknown };
}

/**
 * `deploy:status` — read the log once and print the current state. Exit code
 * encodes the state so a shell `&&`/`||` can branch without parsing stdout:
 * `0` deployed, `1` failed, `2` still running.
 */
export function runDeployStatusCli(options: DeployStatusCliOptions = {}): number {
  const { logPath = 'deploy.log', stdout = process.stdout } = options;
  const status = readDeployStatus(logPath);
  stdout.write(`${formatDeployStatus(status)}\n`);
  return status.state === 'deployed' ? 0 : status.state === 'failed' ? 1 : 2;
}

export interface DeployWaitCliOptions extends DeployStatusCliOptions {
  /** Max time to block before giving up (ms). Default 20 minutes. */
  timeoutMs?: number;
  /** Gap between log reads (ms). Default 2s. */
  intervalMs?: number;
  /** Injected for tests: resolves after `ms`. Default a real unref'd timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests. */
  now?: () => number;
}

/** Default upper bound a `deploy:wait` blocks before reporting a timeout. */
export const DEPLOY_WAIT_TIMEOUT_MS = 20 * 60_000;
/** Default gap between log reads while a `deploy:wait` is polling. */
export const DEPLOY_WAIT_INTERVAL_MS = 2_000;

/** Unref'd sleep so a pending wait never keeps the process alive on its own. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * `deploy:wait` — block until the deploy log reports `deployed` or `failed`,
 * then print the final status and return a state-encoding exit code (`0`
 * deployed, `1` failed, `2` timed out while still running). Reads the log file
 * on an interval; it never touches CloudFormation.
 *
 * The log is produced by the backgrounded deploy, so this stays correct even if
 * the original `npm run deploy` process was reaped — the terminal line is in
 * the file either way.
 */
export async function runDeployWaitCli(options: DeployWaitCliOptions = {}): Promise<number> {
  const {
    logPath = 'deploy.log',
    stdout = process.stdout,
    timeoutMs = DEPLOY_WAIT_TIMEOUT_MS,
    intervalMs = DEPLOY_WAIT_INTERVAL_MS,
    sleep = defaultSleep,
    now = Date.now,
  } = options;

  const startedAt = now();
  // First read is immediate so an already-finished deploy returns at once.
  for (;;) {
    const status = readDeployStatus(logPath);
    if (status.state !== 'running') {
      stdout.write(`${formatDeployStatus(status)}\n`);
      return status.state === 'deployed' ? 0 : 1;
    }
    if (now() - startedAt >= timeoutMs) {
      stdout.write(
        `⏳ still running after ${Math.round((now() - startedAt) / 1000)}s — gave up waiting (the deploy continues in the background; check ${logPath})\n`,
      );
      return 2;
    }
    await sleep(intervalMs);
  }
}
