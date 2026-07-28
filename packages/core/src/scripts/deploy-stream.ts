// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from 'node:child_process';
import { spawnCommand } from './run-command.js';
import { terminateProcessTree } from './process-tree.js';

// Streaming, signal-resilient runner for the long CloudFormation phase of
// `npm run deploy`.
//
// Two failures made a production deploy unobservable and, worse, made a
// SUCCESSFUL deploy look like a failure (callers re-ran it, paying for the same
// stack two or three times):
//
//  1. ZERO BYTES ON STDOUT. The CDK CLI sends every non-error message —
//     including all CloudFormation stack activity — to *stderr* unless CI mode
//     is on: its io host resolves the target stream as
//     `isCI ? process.stdout : process.stderr`. So `npm run deploy > deploy.log`
//     captured nothing at all for the entire (multi-minute) CloudFormation
//     phase, leaving callers to poll `describe-stacks` by hand.
//  2. A BACKGROUNDED DEPLOY DIED ON SIGTERM. The old code ran `cdk deploy`
//     through a *synchronous* spawn, so the event loop was blocked for the whole
//     deploy: signals could not be handled, the default SIGTERM disposition
//     killed the CLI (exit 143), and CloudFormation — which executes
//     server-side once the change set is executing — carried on and finished.
//     The caller saw a dead process with no output and assumed failure.
//
// The fix streams the child's output line by line as it arrives (so stdout is
// never silent), emits an idle heartbeat so a slow resource still produces
// progress, and puts the deploy's lifecycle under this CLI's control: the child
// runs in its own process group and a single SIGTERM/SIGHUP no longer abandons
// an in-flight deploy.

/** What to do with a signal that arrives while a deploy is in flight. */
export type DeploySignalAction = 'defer' | 'abort';

export interface DeploySignalResponse {
  action: DeploySignalAction;
  /** Operator-facing line explaining what happened and how to force an abort. */
  message: string;
}

/** Signals whose delivery we take over while a deploy is in flight. */
export const DEPLOY_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/** Default gap (ms) of silence after which the runner prints a progress heartbeat. */
export const DEFAULT_HEARTBEAT_MS = 30_000;

/** Grace (ms) given to the child tree to exit after an operator-requested abort. */
export const ABORT_GRACE_MS = 10_000;

/**
 * Grace (ms) we wait after the child exits for its stdout/stderr pipes to end,
 * so the last CloudFormation lines are relayed before we resolve. Bounded
 * because a lingering grandchild could hold the pipe open forever; losing a
 * trailing line is strictly better than hanging a finished deploy.
 */
export const STREAM_FLUSH_GRACE_MS = 2_000;

/**
 * Decide how to answer a signal that arrives while CloudFormation is still
 * converging. This is the whole "decouple the CLI lifecycle from the in-flight
 * deploy" policy, kept pure so it can be asserted directly.
 *
 * - `SIGHUP` → always `defer`. A hangup means the terminal or parent shell went
 *   away (a backgrounded `npm run deploy &`, a closed SSH session). The deploy
 *   is server-side work that is already paid for; killing the CLI here is what
 *   produced the phantom failures, so we keep streaming instead.
 * - `SIGTERM` → `defer` the first time, `abort` after that. A lone SIGTERM is
 *   almost always process-group collateral (a harness reaping the parent shell,
 *   a supervisor tidying up) rather than a deliberate "stop the deploy", so the
 *   first one only warns. An operator who really wants to stop sends it again.
 *   A SIGKILL follow-up (`docker stop`, most CI cancels) is uncatchable and
 *   still ends the process immediately, so this cannot wedge a shutdown.
 * - `SIGINT` → always `abort`. Ctrl-C is unambiguous, interactive intent, so it
 *   stays responsive on the first press.
 *
 * @param signal - the signal received.
 * @param termAlreadyDeferred - whether a SIGTERM has already been deferred.
 */
export function decideSignalResponse(
  signal: NodeJS.Signals,
  termAlreadyDeferred: boolean,
): DeploySignalResponse {
  if (signal === 'SIGINT') {
    return {
      action: 'abort',
      message:
        '\n🛑 Interrupted. Stopping the CDK CLI — CloudFormation may keep applying the change set server-side.',
    };
  }
  if (signal === 'SIGHUP') {
    return {
      action: 'defer',
      message:
        '⚠️  Ignoring SIGHUP: the deploy is still running and CloudFormation is still converging. Streaming continues; send SIGTERM twice to abort.',
    };
  }
  if (signal === 'SIGTERM' && !termAlreadyDeferred) {
    return {
      action: 'defer',
      message:
        '⚠️  Ignoring SIGTERM: the deploy is still running and CloudFormation is still converging. Send SIGTERM again to abort (the stack update continues server-side either way).',
    };
  }
  return {
    action: 'abort',
    message: `\n🛑 Received ${signal} while deploying. Stopping the CDK CLI — CloudFormation may keep applying the change set server-side.`,
  };
}

/**
 * Split a byte stream into whole lines across chunk boundaries.
 *
 * The child's output arrives in arbitrary chunks, so a naive
 * `chunk.toString().split('\n')` emits torn lines (and drops the tail). This
 * keeps the partial trailing line buffered until it completes; {@link flush}
 * returns whatever is left when the stream ends (CDK's final line has no
 * trailing newline).
 */
export function createLineAssembler(): {
  push(chunk: string): string[];
  flush(): string[];
} {
  let buffered = '';
  return {
    push(chunk: string): string[] {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
    },
    flush(): string[] {
      if (!buffered) return [];
      const last = buffered.endsWith('\r') ? buffered.slice(0, -1) : buffered;
      buffered = '';
      return last ? [last] : [];
    },
  };
}

/** Human-readable elapsed time (`45s`, `4m 05s`) for progress lines. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export interface CdkDeployArgsOptions {
  /** Project root passed to synth as `--context projectRoot=…`. */
  projectRoot: string;
  /** Path (relative to the project root) CDK writes stack outputs to. */
  outputsFile: string;
}

/**
 * Build the `cdk deploy` argv used by `npm run deploy`.
 *
 * Two of these flags exist purely so the deploy is observable — losing either
 * one brings back the 0-byte stdout:
 *
 * - `--ci`: the CDK CLI picks its log stream as `isCI ? stdout : stderr`, so
 *   without it every CloudFormation event goes to **stderr** and a caller
 *   capturing stdout (`npm run deploy > deploy.log`) sees nothing for the whole
 *   multi-minute deploy. With it, progress goes to stdout and only error-level
 *   messages stay on stderr.
 * - `--progress events`: print one line per resource transition instead of the
 *   redrawing progress bar. The bar needs a TTY, which a piped/backgrounded
 *   deploy does not have, and a half-rendered bar is not a usable progress
 *   signal in a log file.
 */
export function buildCdkDeployArgs({ projectRoot, outputsFile }: CdkDeployArgsOptions): string[] {
  return [
    'cdk',
    'deploy',
    '--require-approval',
    'never',
    '--ci',
    '--progress',
    'events',
    '--outputs-file',
    outputsFile,
    '--context',
    `projectRoot=${projectRoot}`,
  ];
}

/** Unref'd sleep: a pending flush grace must never keep the process alive. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/** Minimal sink surface so tests can capture the relayed streams. */
export interface OutputSink {
  write(chunk: string): unknown;
}

/** Minimal signal-registration surface ({@link process} satisfies it). */
export interface SignalRegistry {
  on(signal: NodeJS.Signals, handler: () => void): unknown;
  off(signal: NodeJS.Signals, handler: () => void): unknown;
}

export interface RunStreamingOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Prefix used by the runner's own progress/status lines. Defaults to `deploy`. */
  label?: string;
  /** Idle gap before a heartbeat line is printed. `0` disables heartbeats. */
  heartbeatMs?: number;
  /** Where child stdout and runner progress lines go. Defaults to `process.stdout`. */
  stdout?: OutputSink;
  /** Where child stderr goes. Defaults to `process.stderr`. */
  stderr?: OutputSink;
  /** Injected for tests. */
  now?: () => number;
  /** Injected for tests: signal registration seam. */
  signalTarget?: SignalRegistry;
}

/** Raised when the child exits non-zero, is killed, or the operator aborts. */
export class DeployProcessError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly aborted: boolean;

  constructor(
    message: string,
    details: { exitCode?: number | null; signal?: NodeJS.Signals | null; aborted?: boolean } = {},
  ) {
    super(message);
    this.name = 'DeployProcessError';
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.aborted = details.aborted ?? false;
  }
}

/**
 * Run a long deployment command, relaying its output line by line as it happens
 * and keeping it alive across a stray SIGTERM/SIGHUP.
 *
 * Behaviour that matters to callers:
 * - **Streamed, non-empty stdout.** Child stdout is relayed to `stdout` the
 *   moment a line completes (never buffered until exit) and child stderr to
 *   `stderr`, so `npm run deploy | tee` shows CloudFormation progress live.
 * - **Idle heartbeat.** While the child is silent for `heartbeatMs`, a
 *   `still deploying` line with elapsed time is written to `stdout`, so a
 *   ten-minute RDS resource never looks like a hung process.
 * - **Own process group.** The child is spawned `detached` on POSIX, so a
 *   process-group signal aimed at the parent shell (`kill -TERM -pgid`, a
 *   harness reaping a backgrounded job) cannot kill the CDK CLI behind our
 *   back; this runner is the only thing that signals it. Windows has no
 *   process groups, so the tree is reaped by pid via `terminateProcessTree`.
 * - **No stdin.** The child gets `ignore` for stdin so a backgrounded deploy
 *   can never be stopped by SIGTTIN trying to read a terminal it no longer
 *   owns; the caller must keep passing `--require-approval never`.
 * - **Signal policy.** See {@link decideSignalResponse}: a deferred signal only
 *   logs (which itself doubles as a progress signal on stdout), while an abort
 *   reaps the child tree and throws a {@link DeployProcessError} with
 *   `aborted: true`.
 *
 * Resolves when the child exits 0; otherwise throws {@link DeployProcessError}.
 */
export async function runStreaming(
  command: string,
  args: string[],
  options: RunStreamingOptions = {},
): Promise<void> {
  const {
    cwd,
    env,
    label = 'deploy',
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    stdout = process.stdout,
    stderr = process.stderr,
    now = Date.now,
    signalTarget = process,
  } = options;

  const startedAt = now();
  let lastOutputAt = startedAt;
  let aborting = false;
  let termDeferred = false;
  let exitObserved = false;

  const child: ChildProcess = spawnCommand(command, args, {
    cwd,
    env,
    // stdin ignored (see doc comment); stdout/stderr piped so we can relay them
    // line by line instead of handing the child our fds and going blind.
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  const relay = (
    stream: NodeJS.ReadableStream | null | undefined,
    sink: OutputSink,
  ): void => {
    if (!stream) return;
    const assembler = createLineAssembler();
    stream.setEncoding('utf-8');
    stream.on('data', (chunk: string) => {
      lastOutputAt = now();
      for (const line of assembler.push(chunk)) sink.write(`${line}\n`);
    });
    stream.on('end', () => {
      for (const line of assembler.flush()) sink.write(`${line}\n`);
    });
  };
  relay(child.stdout, stdout);
  relay(child.stderr, stderr);

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          if (now() - lastOutputAt < heartbeatMs) return;
          stdout.write(
            `⏳ [${label}] still running after ${formatElapsed(now() - startedAt)} — CloudFormation is converging (pid ${child.pid ?? '?'})\n`,
          );
        }, heartbeatMs)
      : undefined;
  // Never let the heartbeat timer be the reason the process stays alive.
  heartbeat?.unref?.();

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        exitObserved = true;
        resolve({ code, signal });
      });
    },
  );
  const streamsEnded = Promise.all(
    [child.stdout, child.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          if (!stream) return resolve();
          stream.once('end', () => resolve());
          stream.once('close', () => resolve());
        }),
    ),
  );

  const handlers = new Map<NodeJS.Signals, () => void>();
  const removeHandlers = (): void => {
    for (const [signal, handler] of handlers) signalTarget.off(signal, handler);
    handlers.clear();
  };

  for (const signal of DEPLOY_SIGNALS) {
    const handler = (): void => {
      // The deploy already finished (we are just draining pipes / reporting):
      // there is nothing left to defer or abort, and reporting an abort here
      // would turn a successful deploy into a failure.
      if (exitObserved) return;
      const { action, message } = decideSignalResponse(signal, termDeferred);
      if (action === 'defer') {
        if (signal === 'SIGTERM') termDeferred = true;
        lastOutputAt = now();
        stdout.write(`${message}\n`);
        return;
      }
      if (aborting) return; // already tearing down; a repeat signal is a no-op
      aborting = true;
      stdout.write(`${message}\n`);
      // Reap the whole tree (npx → cdk → node), not just the npx parent, so an
      // abort cannot leave an orphaned CDK CLI still driving the stack.
      void terminateProcessTree(child, ABORT_GRACE_MS);
    };
    handlers.set(signal, handler);
    signalTarget.on(signal, handler);
  }

  try {
    const { code, signal } = await exited;
    // Let the pipes drain so a caller reading our stdout sees the child's final
    // lines (CDK's summary / failure reason) before the terminal status.
    await Promise.race([streamsEnded, delay(STREAM_FLUSH_GRACE_MS)]);
    if (aborting) {
      throw new DeployProcessError(
        `${command} was aborted by an operator signal after ${formatElapsed(now() - startedAt)}`,
        { exitCode: code, signal, aborted: true },
      );
    }
    if (signal) {
      throw new DeployProcessError(`${command} was terminated by signal ${signal}`, {
        exitCode: code,
        signal,
      });
    }
    if (code !== 0) {
      throw new DeployProcessError(
        `${command} ${args.join(' ')} exited with code ${code}`,
        { exitCode: code },
      );
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    removeHandlers();
  }
}
