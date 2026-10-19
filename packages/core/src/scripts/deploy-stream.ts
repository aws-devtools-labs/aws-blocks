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
//
// The signal half of that is POSIX-only. It relies on process groups (`detached`)
// and on real SIGTERM/SIGHUP delivery, neither of which Windows has: `detached`
// is passed only when `process.platform !== 'win32'`, and on Windows nothing
// outside the process delivers those signals (a `taskkill` on the tree still
// ends the deploy). Streaming, the heartbeat and the argv contract are
// cross-platform; only "survives a stray reap" is POSIX.

/** What to do with a signal that arrives while a deploy is in flight. */
export type DeploySignalAction = 'defer' | 'abort';

export interface DeploySignalResponse {
  action: DeploySignalAction;
  /** Operator-facing line explaining what happened and how to force an abort. */
  message: string;
  /**
   * True when this signal is a duplicate delivery of one the operator already
   * sent (see {@link SIGNAL_COALESCE_MS}), so the caller can skip logging it
   * twice.
   */
  coalesced?: boolean;
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
 * Window (ms) in which repeated SIGTERMs count as ONE operator request.
 *
 * A single external signal reaches this process more than once. `npm run deploy`
 * runs `npm -> sh -> tsx -> node`, so a process-group SIGTERM is delivered to
 * the node process directly AND relayed to it a second time by `tsx`, which
 * forwards SIGTERM/SIGINT to its child. Measured on a real deploy: one
 * `kill -TERM -<pgid>` produced two SIGTERMs about 50ms apart. Without this
 * window the second delivery is read as "the operator insisted" and the deploy
 * is abandoned, which is the exact failure this module exists to prevent.
 *
 * 2s is far longer than a delivery burst (tens of ms) and far shorter than a
 * deliberate repeat (a human running `kill` twice, or a supervisor's
 * SIGTERM-then-escalate cycle), so both intents stay distinguishable.
 */
export const SIGNAL_COALESCE_MS = 2_000;

/**
 * Decide how to answer a signal that arrives while CloudFormation is still
 * converging. This is the whole "decouple the CLI lifecycle from the in-flight
 * deploy" policy, kept pure so it can be asserted directly.
 *
 * - `SIGHUP` → always `defer`. A hangup means the terminal or parent shell went
 *   away (a backgrounded `npm run deploy &`, a closed SSH session). The deploy
 *   is server-side work that is already paid for; killing the CLI here is what
 *   produced the phantom failures, so we keep streaming instead. Duplicate
 *   deliveries inside {@link SIGNAL_COALESCE_MS} are coalesced so one hangup
 *   logs one line, not one per delivery.
 * - `SIGTERM` → `defer` the first time. A lone SIGTERM is almost always
 *   process-group collateral (a harness reaping the parent shell, a supervisor
 *   tidying up) rather than a deliberate "stop the deploy", so it only warns.
 *   Repeats inside {@link SIGNAL_COALESCE_MS} are duplicate *deliveries* of that
 *   same signal (the group delivers it, then `tsx` relays it) and are coalesced
 *   into the first. A SIGTERM after that window is a deliberate repeat and
 *   aborts. A SIGKILL follow-up (`docker stop`, most CI cancels) is uncatchable
 *   and still ends the process immediately, so this cannot wedge a shutdown.
 * - `SIGINT` → always `abort`. Ctrl-C is unambiguous, interactive intent, so it
 *   stays responsive on the first press.
 *
 * @param signal - the signal received.
 * @param msSinceFirstDeferral - ms since the first deferral of *this* signal, or
 *   `null` when this signal has not been deferred yet. Each signal is tracked
 *   separately, so a deferred SIGHUP never consumes the SIGTERM abort budget
 *   (and a repeated SIGHUP is deduped the same way a repeated SIGTERM is).
 * @param coalesceWindowMs - see {@link SIGNAL_COALESCE_MS}.
 */
export function decideSignalResponse(
  signal: NodeJS.Signals,
  msSinceFirstDeferral: number | null,
  coalesceWindowMs: number = SIGNAL_COALESCE_MS,
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
      coalesced: msSinceFirstDeferral !== null && msSinceFirstDeferral < coalesceWindowMs,
    };
  }
  if (signal === 'SIGTERM' && msSinceFirstDeferral === null) {
    return {
      action: 'defer',
      message:
        '⚠️  Ignoring SIGTERM: the deploy is still running and CloudFormation is still converging. Send SIGTERM again to abort (the stack update continues server-side either way).',
    };
  }
  if (signal === 'SIGTERM' && msSinceFirstDeferral !== null && msSinceFirstDeferral < coalesceWindowMs) {
    // Same signal reaching us twice (process group + a wrapper's relay), not a
    // second request — keep deploying and stay quiet about the duplicate.
    return {
      action: 'defer',
      message: '',
      coalesced: true,
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

/** One resource transition parsed from a `cdk deploy --progress events` line. */
export interface CdkResourceEvent {
  /** CloudFormation resource status, e.g. `CREATE_IN_PROGRESS`, `CREATE_COMPLETE`. */
  status: string;
  /** CloudFormation resource type, e.g. `AWS::CloudFront::Distribution`. */
  resourceType: string;
  /** The resource's logical id, e.g. `HostingDistribution`. */
  logicalId: string;
}

// A `cdk deploy --progress events` line is pipe-delimited:
//   StackName | STATUS | Namespace::Service::Type | LogicalId  [| optional reason]
// CDK prefixes each with a spinner/timestamp fragment and pads the columns, so
// we match the STATUS | TYPE | LOGICALID triple anywhere in the line rather
// than anchoring to the start. STATUS is an uppercase CloudFormation status
// (a self-clearing transient the tracker ignores), TYPE is a CloudFormation
// resource type — `AWS::x::y`, but also `Custom::x` (a custom resource such as
// the DistributedTable GSI manager, which is exactly what a serialized-GSI
// deploy sits on) — and LOGICALID is the first token after it. Purely
// structural: no dependency on CDK's exact spacing or leading fragment.
const CDK_EVENT_LINE = /\b([A-Z][A-Z0-9_]*(?:_IN_PROGRESS|_COMPLETE|_FAILED))\s*\|\s*([A-Za-z0-9]+::[A-Za-z0-9:]+)\s*\|\s*([^\s|]+)/;

/**
 * Parse a single CDK `--progress events` line into a resource transition, or
 * return `null` for any line that is not one (banners, summaries, blank lines).
 * Pure and exported so the parsing is unit-tested directly against real CDK
 * output shapes.
 */
export function parseCdkEventLine(line: string): CdkResourceEvent | null {
  const m = CDK_EVENT_LINE.exec(line);
  if (!m) return null;
  return { status: m[1], resourceType: m[2], logicalId: m[3] };
}

/**
 * Whether a CloudFormation status is a ROLLBACK — a failure being undone, not
 * forward progress. Both `ROLLBACK_IN_PROGRESS` and `UPDATE_ROLLBACK_COMPLETE`
 * qualify; the latter ENDS in `_COMPLETE` but is emphatically not a clean
 * completion, which is the distinction the tracker and heartbeat turn on.
 */
export function isRollbackStatus(status: string): boolean {
  return status.includes('ROLLBACK');
}

/**
 * Render the human-friendly resource name used in the heartbeat, e.g.
 * `HostingDistribution (AWS::CloudFront::Distribution)`. A resource that is
 * rolling back is flagged so the heartbeat surfaces the failure ("⚠️ … rolling
 * back") instead of reading like ordinary progress. Kept pure so the wording is
 * asserted without a running deploy.
 */
export function describeConvergingResource(event: CdkResourceEvent): string {
  const name = `${event.logicalId} (${event.resourceType})`;
  return isRollbackStatus(event.status) ? `⚠️ ${name} rolling back` : name;
}

/**
 * Track which resource is currently converging, from the stream of CDK event
 * lines. A resource becomes "current" when it enters `*_IN_PROGRESS` and is
 * cleared when it reaches a terminal `*_COMPLETE` / `*_FAILED`, so the heartbeat
 * can say what the deploy is actually waiting on right now instead of a bare
 * tick. Pure and stateful like {@link createLineAssembler}; feed it every
 * relayed line.
 */
export function createResourceTracker(): {
  observe(line: string): void;
  current(): CdkResourceEvent | null;
} {
  let current: CdkResourceEvent | null = null;
  return {
    observe(line: string): void {
      const event = parseCdkEventLine(line);
      if (!event) return;
      if (event.status.endsWith('_IN_PROGRESS')) {
        // Covers both forward progress (CREATE/UPDATE/DELETE_IN_PROGRESS) and
        // UPDATE_ROLLBACK_IN_PROGRESS — a rollback is still something the deploy
        // is actively doing, and it is a failure signal the heartbeat should
        // keep naming rather than fall silent on.
        current = event;
      } else if (
        current &&
        event.logicalId === current.logicalId &&
        isRollbackStatus(event.status)
      ) {
        // A ROLLBACK reached its terminal state. This ENDS in `_COMPLETE`
        // (UPDATE_ROLLBACK_COMPLETE / ROLLBACK_COMPLETE), but it is NOT a clean
        // settle — the resource failed and was rolled back. Keep it current so
        // the heartbeat surfaces the rollback instead of silently clearing it
        // as if the deploy succeeded.
        current = event;
      } else if (
        current &&
        event.logicalId === current.logicalId &&
        (event.status.endsWith('_COMPLETE') || event.status.endsWith('_FAILED'))
      ) {
        // A clean terminal (CREATE/UPDATE/DELETE_COMPLETE) or a plain _FAILED:
        // the resource we were reporting on has settled; stop naming it. The
        // next _IN_PROGRESS line names whatever the deploy moves on to.
        current = null;
      }
    },
    current: () => current,
  };
}

// CDK prints the stack's CloudFront/hosting URL as an Outputs line once the
// distribution is created, e.g.  `Foo.HostingDistributionUrl = https://d123.cloudfront.net`
// — which lands on stdout well BEFORE full CREATE_COMPLETE and the post-run
// outputs.json read. Matching it lets deploy() surface the URL early, so a
// deploy that is still converging (or gets killed at a caller timeout) has
// already told the agent where the app lives.
const CDK_HOSTING_URL_LINE = /(?:Hosting|Cdn|Distribution)\w*Url\s*[:=]\s*(https:\/\/[^\s]+)/i;

/**
 * Extract the hosting (CloudFront) URL from a single streamed line, or `null`.
 * Pure and exported so the recognition is unit-tested against real CDK Outputs
 * shapes without a deploy.
 */
export function extractHostingUrlFromLine(line: string): string | null {
  const m = CDK_HOSTING_URL_LINE.exec(line);
  return m ? m[1].replace(/[.,);]+$/, '') : null;
}

/**
 * The single machine-readable completion line a caller (a coding agent, a CI
 * step, a script) greps for "deploy done + where it lives", instead of parsing
 * CloudFormation output or polling the stack. Pure + exported so it is unit
 * tested and shared by both `deploy()` and `sandbox()`; each prints exactly this
 * string on its success path. `api=` is always present; `url=` (the public
 * frontend) only when the app deployed hosting — a sandbox deploy serves the
 * frontend locally, so it omits `url=`.
 */
export function formatDeploySignal(apiUrl: string, hostingUrl?: string): string {
  return hostingUrl
    ? `BLOCKS_DEPLOYED url=${hostingUrl} api=${apiUrl}`
    : `BLOCKS_DEPLOYED api=${apiUrl}`;
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
  /**
   * Called with the hosting (CloudFront) URL the first time it is seen in the
   * streamed CDK output — which is BEFORE the child exits and the post-run
   * outputs.json read. Lets a caller emit the "deployed" signal early so it
   * survives a caller-timeout kill. Fired at most once.
   */
  onHostingUrl?: (url: string) => void;
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
 * - **Own process group (POSIX only).** The child is spawned `detached` on
 *   POSIX, so a process-group signal aimed at the parent shell
 *   (`kill -TERM -pgid`, a harness reaping a backgrounded job) cannot kill the
 *   CDK CLI behind our back; this runner is the only thing that signals it.
 *   Windows has neither process groups nor OS-delivered SIGTERM/SIGHUP, so the
 *   signal resilience below does not apply there — a `taskkill` on the tree ends
 *   the deploy, and the abort path reaps by pid via `terminateProcessTree`.
 * - **No stdin.** The child gets `ignore` for stdin so a backgrounded deploy
 *   can never be stopped by SIGTTIN trying to read a terminal it no longer
 *   owns; the caller must keep passing `--require-approval never`.
 * - **Signal policy (POSIX).** See {@link decideSignalResponse}: a deferred
 *   signal only logs (which itself doubles as a progress signal on stdout),
 *   while an abort reaps the child tree and throws a {@link DeployProcessError}
 *   with `aborted: true`. Repeat deliveries of the same signal inside
 *   {@link SIGNAL_COALESCE_MS} log once, not once per delivery.
 * - **Streams stay separated.** Child stdout and child stderr are relayed to
 *   their own sinks and never merged, so a deploy failure reason (which the CDK
 *   CLI keeps on stderr even under `--ci`) stays on stderr while progress is on
 *   stdout.
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
    onHostingUrl,
  } = options;

  const startedAt = now();
  let lastOutputAt = startedAt;
  let aborting = false;
  let exitObserved = false;
  // Tracks the resource CloudFormation is currently converging, so the
  // heartbeat can name it instead of printing a bare tick.
  const resources = createResourceTracker();
  // The hosting URL is reported at most once, the first time it appears in the
  // stream (well before the child exits).
  let hostingUrlSeen = false;
  // Per signal, when its current deferral window opened. Kept per signal so a
  // deferred SIGHUP neither consumes the SIGTERM abort budget nor silently
  // swallows its own log line.
  const deferredAt = new Map<NodeJS.Signals, number>();

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
    trackProgress: boolean,
  ): void => {
    if (!stream) return;
    const assembler = createLineAssembler();
    stream.setEncoding('utf-8');
    stream.on('data', (chunk: string) => {
      lastOutputAt = now();
      for (const line of assembler.push(chunk)) {
        if (trackProgress) observeProgressLine(line);
        sink.write(`${line}\n`);
      }
    });
    stream.on('end', () => {
      for (const line of assembler.flush()) {
        if (trackProgress) observeProgressLine(line);
        sink.write(`${line}\n`);
      }
    });
  };
  // Update the converging-resource tracker and surface the hosting URL the first
  // time it appears — both read from the CDK progress stream on stdout.
  const observeProgressLine = (line: string): void => {
    resources.observe(line);
    if (!hostingUrlSeen && onHostingUrl) {
      const url = extractHostingUrlFromLine(line);
      if (url) {
        hostingUrlSeen = true;
        onHostingUrl(url);
      }
    }
  };
  relay(child.stdout, stdout, true);
  relay(child.stderr, stderr, false);

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          if (now() - lastOutputAt < heartbeatMs) return;
          const converging = resources.current();
          const waitingOn = converging
            ? `waiting on ${describeConvergingResource(converging)}`
            : 'CloudFormation is converging';
          stdout.write(
            `⏳ [${label}] still running after ${formatElapsed(now() - startedAt)} — ${waitingOn} (pid ${child.pid ?? '?'})\n`,
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
      const openedAt = deferredAt.get(signal);
      const { action, message, coalesced } = decideSignalResponse(
        signal,
        openedAt === undefined ? null : now() - openedAt,
      );
      if (action === 'defer') {
        // A coalesced duplicate is the same signal arriving twice (process group
        // plus a wrapper relay); log it once, not once per delivery. Anything
        // outside the window is a fresh request, so it opens a new window and
        // reports again instead of being muted for the rest of the deploy.
        if (!coalesced) {
          deferredAt.set(signal, now());
          lastOutputAt = now();
          stdout.write(`${message}\n`);
        }
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
