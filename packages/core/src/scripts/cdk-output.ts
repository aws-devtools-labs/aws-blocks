// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Curates the output of the CDK children the lifecycle scripts spawn (`cdk
 * deploy`, `cdk destroy`, `cdk synth`, `cdk watch`) according to
 * `BLOCKS_LOG_LEVEL` (see {@link ./log.ts}).
 *
 * - `legacy`, `verbose`, `debug`: nothing changes. Synchronous children keep
 *   inherited stdio, the streaming deploy relays every line, and `cdk watch`
 *   keeps its existing relay.
 * - `normal`: the raw stream becomes a few milestones and a progress count
 *   ({@link createCdkProgressReporter}). Failure, rollback and error-shaped
 *   lines pass through verbatim, on the stream they arrived on.
 * - `quiet`: no child output is shown while the operation runs.
 *
 * At `quiet` and `normal` every raw child line is kept in a bounded ring
 * ({@link createOutputRing}, the last {@link DEFAULT_RETAINED_LINES} lines).
 * When the operation fails, the caller prints it to stderr
 * ({@link CdkOutput.printRetained}) before the error, so the reason a deploy
 * failed is never lost to filtering and never needs a re-run to recover.
 */

import type { ChildProcess } from 'node:child_process';
import {
  type CuratedStreams,
  createLineAssembler,
  formatElapsed,
  isRollbackStatus,
  type OutputSink,
  parseCdkEventLine,
  STREAM_FLUSH_GRACE_MS,
} from './deploy-stream.js';
import {
  BLOCKS_LOG_LEVEL_ENV,
  type BlocksLogLevel,
  isCuratedLevel,
  progressToStderr,
  resolveLogLevel,
} from './log.js';
import { runSync, spawnCommand } from './run-command.js';

/** How many raw child lines are retained for the failure dump. */
export const DEFAULT_RETAINED_LINES = 500;

/** Minimum gap between two piped (non-TTY) progress lines at `normal`. */
export const PIPED_PROGRESS_INTERVAL_MS = 10_000;

/** A bounded ring of the most recent lines. */
export interface OutputRing {
  push(line: string): void;
  /** The retained lines, oldest first. */
  lines(): string[];
  /** How many lines were pushed in total (retained or not). */
  total(): number;
  clear(): void;
}

/** A ring that keeps the last `limit` lines pushed into it. */
export function createOutputRing(limit: number = DEFAULT_RETAINED_LINES): OutputRing {
  const slots: string[] = new Array(Math.max(1, limit));
  let next = 0;
  let count = 0;
  return {
    push(line: string): void {
      slots[next] = line;
      next = (next + 1) % slots.length;
      count++;
    },
    lines(): string[] {
      if (count <= slots.length) return slots.slice(0, count);
      return [...slots.slice(next), ...slots.slice(0, next)];
    },
    total: () => count,
    clear(): void {
      next = 0;
      count = 0;
    },
  };
}

/**
 * The failure dump for `ring`: the retained raw lines framed by a header that
 * names the command and how much was kept. Empty string when nothing was
 * retained.
 */
export function formatRetainedOutput(ring: OutputRing, label: string, level: BlocksLogLevel): string {
  const lines = ring.lines();
  if (lines.length === 0) return '';
  const total = ring.total();
  const extent = total > lines.length ? `last ${lines.length} of ${total} lines` : `${total} line${total === 1 ? '' : 's'}`;
  return [
    '',
    `──── ${label} output (${extent}, retained because ${BLOCKS_LOG_LEVEL_ENV}=${level}) ────`,
    ...lines,
    `──── end of ${label} output ────`,
    '',
  ].join('\n');
}

// ── Line classification (ported from the `blocks` CLI prototype's stream filter) ──

/** Runtime/SDK chatter that is never worth showing, even as a milestone. */
const NOISE_LINE =
  /NodeVersionSupportWarning|trace-warnings|^\(node:\d+\)|AWS SDK for JavaScript|^\s*More information can be found|require node >=|security updates please upgrade|versions published after/;

/**
 * A line that reports a failure or rollback. Shown verbatim at `normal`:
 * hiding a failure reason would be worse than any amount of noise.
 */
export function isCdkFailureLine(line: string): boolean {
  return (
    /ROLLBACK|_FAILED\b/.test(line) ||
    /\b(error|failed|failure|exception)\b/i.test(line) ||
    // Compound JS error names (`SyntaxError`, `TypeError`, `ValidationException`), e.g. a synth crash.
    /\b[A-Z]\w*(Error|Exception)\b/.test(line) ||
    /^\s*❌/.test(line)
  );
}

/** A pre-CloudFormation synth/bundling marker. */
const SYNTH_LINE = /✨\s+Synthesis time:|\b(synthesi|bundling|building assets?)/i;

/** CDK's stack-level completion markers. */
const STACK_DONE_LINE = /^\s*✅\s|✨\s+(Deployment|Total) time:/;

// `cdk deploy --progress events --ci` prints `Stack | 3/10 | time | STATUS | Type | Id`.
const EVENT_PROGRESS = /\|\s*(\d+)\s*\/\s*(\d+)\s*\|/;

export interface CdkProgressReporterOptions {
  /** Whether stdout is an interactive terminal (the progress line redraws in place). */
  isTty?: boolean;
  now?: () => number;
  /** `deploy` (resources to apply) or `destroy` (resources to remove). Default `deploy`. */
  verb?: 'deploy' | 'destroy';
  /** Minimum gap between piped progress lines. Default {@link PIPED_PROGRESS_INTERVAL_MS}. */
  pipedIntervalMs?: number;
}

/** Curated `normal`-level rendering of a CDK child's output. */
export interface CdkProgressReporter {
  /** Feed one raw line (no trailing newline) from the child's stdout or stderr. */
  line(line: string, from: 'stdout' | 'stderr'): void;
  /** Print a runner status line (heartbeat, signal notice) to stdout. */
  note(text: string): void;
  /** Close the progress line; on success print the resource summary. */
  finish(ok: boolean): void;
}

/**
 * Translate the raw CDK stream into milestones plus one progress indicator:
 *
 *     Synthesizing app...
 *     CloudFormation: 12 resources to apply
 *     CloudFormation... 7/12 resources        (redrawn in place on a TTY)
 *     12 resources applied in 1m 48s
 *
 * Every resource event is counted (a `*_COMPLETE` per logical id, or CDK's own
 * `N/M` counter when the stream has one), so it works for the production
 * `--progress events --ci` stream and the sandbox/destroy default stream.
 * Failure lines are written verbatim to the stream they came from; everything
 * else is dropped (the caller retains it for the failure dump).
 *
 * Adapted from the `blocks` CLI prototype's deploy-progress reporter.
 */
export function createCdkProgressReporter(
  stdout: OutputSink,
  stderr: OutputSink,
  options: CdkProgressReporterOptions = {},
): CdkProgressReporter {
  const { isTty = false, now = Date.now, verb = 'deploy', pipedIntervalMs = PIPED_PROGRESS_INTERVAL_MS } = options;
  const startedAt = now();
  const completed = new Set<string>();
  let counter = 0;
  let total: number | null = null;
  let announcedSynth = false;
  let announcedEvents = false;
  let liveLine = false;
  let lastPiped = '';
  let lastPipedAt = Number.NEGATIVE_INFINITY;

  const clearLive = (): void => {
    if (!liveLine) return;
    stdout.write('\r\x1b[K');
    liveLine = false;
  };
  const milestone = (sink: OutputSink, text: string): void => {
    clearLive();
    sink.write(`${text}\n`);
  };
  const done = (): number => {
    const n = Math.max(completed.size, counter);
    return total ? Math.min(n, total) : n;
  };
  const plural = (n: number): string => (n === 1 ? '' : 's');
  const renderProgress = (force: boolean): void => {
    const n = done();
    const tail = total ? `${n}/${total} resources` : `${n} resource${plural(n)}`;
    if (isTty) {
      stdout.write(`\r\x1b[K   CloudFormation... ${tail} · ${formatElapsed(now() - startedAt)}`);
      liveLine = true;
      return;
    }
    // Piped: one line per real change, throttled; `0/N` would only repeat the announcement.
    if (n === 0 || tail === lastPiped) return;
    if (!force && now() - lastPipedAt < pipedIntervalMs) return;
    lastPiped = tail;
    lastPipedAt = now();
    stdout.write(`   CloudFormation... ${tail}\n`);
  };

  return {
    line(raw: string, from: 'stdout' | 'stderr'): void {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.trim() === '' || NOISE_LINE.test(line)) return;
      const event = parseCdkEventLine(line);
      if (isCdkFailureLine(line) || (event && isRollbackStatus(event.status))) {
        milestone(from === 'stderr' ? stderr : stdout, line.trim());
        return;
      }
      if (event) {
        const progress = EVENT_PROGRESS.exec(line);
        if (progress) {
          counter = Math.max(counter, Number(progress[1]));
          total = Math.max(total ?? 0, Number(progress[2])) || null;
        }
        if (!announcedEvents) {
          announcedEvents = true;
          const action = verb === 'destroy' ? 'remove' : 'apply';
          milestone(stdout, total ? `   CloudFormation: ${total} resource${plural(total)} to ${action}` : `   CloudFormation: ${verb === 'destroy' ? 'removing' : 'applying'} changes`);
        }
        if (event.status.endsWith('_COMPLETE') && event.resourceType !== 'AWS::CloudFormation::Stack') {
          completed.add(event.logicalId);
        }
        renderProgress(false);
        return;
      }
      if (!announcedEvents && !announcedSynth && SYNTH_LINE.test(line)) {
        announcedSynth = true;
        milestone(stdout, '   Synthesizing app...');
        return;
      }
      if (announcedEvents && STACK_DONE_LINE.test(line)) renderProgress(true);
    },
    note(text: string): void {
      milestone(stdout, text);
    },
    finish(ok: boolean): void {
      clearLive();
      if (!ok || !announcedEvents) return;
      const n = total ?? done();
      stdout.write(`   ${n} resource${plural(n)} ${verb === 'destroy' ? 'removed' : 'applied'} in ${formatElapsed(now() - startedAt)}\n`);
    },
  };
}

export interface CdkOutputOptions {
  /** Names the command in the failure dump header, e.g. `cdk deploy`. */
  label: string;
  verb?: 'deploy' | 'destroy';
  /** Default: {@link resolveLogLevel} at creation. */
  level?: BlocksLogLevel;
  /** Default `process.stdout`. */
  stdout?: OutputSink;
  /** Default `process.stderr`. */
  stderr?: OutputSink;
  /** Default: whether `process.stdout` is a TTY (only when `stdout` is `process.stdout`). */
  isTty?: boolean;
  now?: () => number;
  /** Default {@link DEFAULT_RETAINED_LINES}. */
  retainLines?: number;
}

/** Options for {@link CdkOutput.run}. */
export interface CdkRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** One operation's CDK output policy: how its children are run and relayed. */
export interface CdkOutput {
  readonly level: BlocksLogLevel;
  /** True at `quiet`/`normal`: child output is condensed and retained. */
  readonly curated: boolean;
  /**
   * The sinks to hand `runStreaming` as `curated`, or `undefined` when output
   * is not curated (so `runStreaming` keeps relaying raw lines).
   */
  readonly streams: CuratedStreams | undefined;
  /**
   * Run a CDK child to completion; throws on failure. Not curated: exactly
   * `runSync(command, args, { stdio: 'inherit', ...options })` (synchronous).
   * Curated: stdout/stderr are piped through the reporter and retained, stdin
   * stays inherited, the progress summary prints on success, and failures
   * throw the same messages `runSync` does. Never prints the retained output:
   * a retried step (destroy) fails more than once before the operation does.
   */
  run(command: string, args: string[], options?: CdkRunOptions): void | Promise<void>;
  /** Print the retained raw output to stderr (curated levels only; no-op when empty). */
  printRetained(): void;
}

/** Build the {@link CdkOutput} for one operation at the current log level. */
export function createCdkOutput(options: CdkOutputOptions): CdkOutput {
  const level = options.level ?? resolveLogLevel();
  const curated = isCuratedLevel(level);
  // With BLOCKS_LOG_STREAM=stderr the curated milestones and the raw CDK output go to stderr.
  const toStderr = progressToStderr();
  const stdout = options.stdout ?? (toStderr ? process.stderr : process.stdout);
  const stderr = options.stderr ?? process.stderr;
  const isTty =
    options.isTty ??
    ((stdout === process.stdout || stdout === process.stderr) && (stdout as NodeJS.WriteStream).isTTY === true);
  const ring = createOutputRing(options.retainLines);
  const reporter =
    level === 'normal'
      ? createCdkProgressReporter(stdout, stderr, { isTty, now: options.now, verb: options.verb })
      : undefined;

  const feed = (from: 'stdout' | 'stderr'): OutputSink => ({
    write(chunk: string): boolean {
      const lines = chunk.endsWith('\n') ? chunk.slice(0, -1).split('\n') : chunk.split('\n');
      for (const line of lines) {
        ring.push(line);
        reporter?.line(line, from);
      }
      return true;
    },
  });

  const streams: CuratedStreams | undefined = curated
    ? {
        stdout: feed('stdout'),
        stderr: feed('stderr'),
        status(message: string, kind: 'heartbeat' | 'signal'): void {
          // A heartbeat is progress (hidden at quiet); a signal notice tells the
          // operator their signal was ignored or acted on, so it always prints.
          if (reporter) reporter.note(message);
          else if (kind === 'signal') stdout.write(`${message}\n`);
        },
        close(ok: boolean): void {
          reporter?.finish(ok);
        },
      }
    : undefined;

  return {
    level,
    curated,
    streams,
    run(command: string, args: string[], runOptions: CdkRunOptions = {}): void | Promise<void> {
      if (!streams) {
        return runSync(command, args, { stdio: toStderr ? ['inherit', 2, 'inherit'] : 'inherit', ...runOptions });
      }
      return runCurated(command, args, runOptions, streams);
    },
    printRetained(): void {
      if (!curated) return;
      const dump = formatRetainedOutput(ring, options.label, level);
      if (dump) stderr.write(dump);
      ring.clear();
    },
  };
}

/** Run a child with piped stdout/stderr relayed line by line into `streams`. */
async function runCurated(
  command: string,
  args: string[],
  { cwd, env }: CdkRunOptions,
  streams: CuratedStreams,
): Promise<void> {
  let ok = false;
  let child: ChildProcess | undefined;
  try {
    const spawned = spawnCommand(command, args, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] });
    child = spawned;
    const ended = [relayLines(spawned.stdout, streams.stdout), relayLines(spawned.stderr, streams.stderr)];
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        spawned.once('error', reject);
        spawned.once('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
      },
    );
    // Bounded drain, as in runStreaming: a grandchild holding a pipe open must
    // not hang a finished command.
    await Promise.race([Promise.all(ended), new Promise((r) => setTimeout(r, STREAM_FLUSH_GRACE_MS).unref())]);
    // Same failure messages as runSync, so callers see one contract.
    if (signal) throw new Error(`${command} was terminated by signal ${signal}`);
    if (typeof code === 'number' && code !== 0) throw new Error(`${command} ${args.join(' ')} exited with code ${code}`);
    ok = true;
  } finally {
    // A descendant still holding the pipes must not keep this process alive.
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    streams.close(ok);
  }
}

/** Relay a stream line by line into `sink`; resolves when the stream ends. */
function relayLines(stream: NodeJS.ReadableStream | null | undefined, sink: OutputSink): Promise<void> {
  return new Promise((resolve) => {
    if (!stream) return resolve();
    const assembler = createLineAssembler();
    stream.setEncoding('utf-8');
    stream.on('data', (chunk: string) => {
      for (const line of assembler.push(chunk)) sink.write(`${line}\n`);
    });
    stream.once('end', () => {
      for (const line of assembler.flush()) sink.write(`${line}\n`);
      resolve();
    });
    stream.once('close', () => resolve());
  });
}

/** Lambda platform lines `cdk watch` tails from CloudWatch; never relayed. */
const LAMBDA_PLATFORM_LINE = /\[(START|END|REPORT|INIT_START)\s+RequestId:/;

/** `cdk watch` progress lines worth showing at `normal` (besides failures): change detection, hotswaps, outcomes. */
const WATCH_PROGRESS_LINE = /Detected change|hotswap|Deployment time|^\s*✅/i;

/**
 * CDK's own markers for the start of a watch deploy cycle. A change detected
 * while a deploy is running is only queued (it starts a cycle later through
 * "Invoking 'cdk deploy' again"), so it is not a start.
 */
const WATCH_CYCLE_START_LINE =
  /Detected change(?!.*while 'cdk deploy' is still running)|Triggering initial 'cdk deploy'|Invoking 'cdk deploy' again/;

/**
 * CDK's own watch bookkeeping lines (aws-cdk `cdk-toolkit.js`), matched by their fixed message text
 * so an embedded path such as `src/app/error.tsx` never reads as a failure.
 */
const WATCH_OWN_LINE = new RegExp(
  [
    /Detected change/,
    /Detected file changes during deployment\. Invoking 'cdk deploy' again/,
    /Triggering initial 'cdk deploy'/,
    /^\s*'watch' is observing (?:directory|the file) '.*' for changes\s*$/,
    /^\s*'watch' received the 'ready' event\. From now on, all file changes will trigger a deployment\s*$/,
    /^\s*root directory used for 'watch' is: /,
    /^\s*'(?:include|exclude)' patterns for 'watch': /,
  ]
    .map((r) => r.source)
    .join('|'),
);

/** A watch deploy cycle that succeeded. */
const WATCH_CYCLE_DONE_LINE = /^\s*✅|✨\s+(Deployment|Total) time:/;

/** Default quiet period after a failure line before a cycle with no outcome counts as failed. */
const WATCH_FAILURE_IDLE_MS = 3000;

export interface CdkWatchOutputOptions {
  /** Default: {@link resolveLogLevel} at attach time. */
  level?: BlocksLogLevel;
  /** Default `process.stderr` (curated levels only). */
  stderr?: OutputSink;
  /** True while the caller is tearing the watch down, so its exit is not a failure. */
  stopping?: () => boolean;
  /** Default {@link DEFAULT_RETAINED_LINES}. */
  retainLines?: number;
  /** Default {@link WATCH_FAILURE_IDLE_MS}. */
  failureIdleMs?: number;
}

/**
 * Relay a `cdk watch` child's output.
 *
 * Not curated: the sandbox's original relay, unchanged — each stdout chunk is
 * trimmed and printed as `[CDK Watch] …` (Lambda START/END/REPORT lines
 * dropped), and each stderr chunk likewise via `console.error`.
 *
 * Curated: output is split into whole lines and retained. At `normal`, only
 * {@link WATCH_PROGRESS_LINE} and failure lines print (same `[CDK Watch]` prefix and stream).
 * When a watch deploy fails (a `❌` line) or `cdk watch` itself exits non-zero,
 * the retained lines since the last failure are printed to stderr, so a failed
 * hotswap is diagnosable without re-running with a higher level.
 *
 * A cycle that dies during synth prints no `❌`: CDK swallows the error and
 * keeps watching. So a cycle that logged a failure line and no success marker
 * also counts as failed once the next cycle starts or output goes quiet for
 * `failureIdleMs`.
 */
export function attachCdkWatchOutput(child: ChildProcess, options: CdkWatchOutputOptions = {}): void {
  const level = options.level ?? resolveLogLevel();
  if (!isCuratedLevel(level)) {
    child.stdout?.on('data', (data) => {
      const str = data.toString().trim();
      if (!str.match(/\[(START|END|REPORT|INIT_START)\s+RequestId:/)) {
        (progressToStderr() ? console.error : console.log)(`[CDK Watch] ${str}`);
      }
    });
    child.stderr?.on('data', (data) => {
      console.error(`[CDK Watch] ${data.toString().trim()}`);
    });
    return;
  }

  const stderr = options.stderr ?? process.stderr;
  const ring = createOutputRing(options.retainLines);
  const failureIdleMs = options.failureIdleMs ?? WATCH_FAILURE_IDLE_MS;
  // Whether a deploy cycle is running, and whether it has logged a failure line.
  let inCycle = true;
  let cycleFailed = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const clearIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const dump = (): void => {
    clearIdle();
    cycleFailed = false;
    inCycle = false;
    const text = formatRetainedOutput(ring, 'cdk watch', level);
    if (text) stderr.write(text);
    ring.clear();
  };
  const relay = (stream: NodeJS.ReadableStream | null | undefined, from: 'stdout' | 'stderr'): void => {
    if (!stream) return;
    const assembler = createLineAssembler();
    const handle = (line: string): void => {
      if (line.trim() === '' || LAMBDA_PLATFORM_LINE.test(line) || NOISE_LINE.test(line)) return;
      const ownLine = WATCH_OWN_LINE.test(line);
      if (WATCH_CYCLE_START_LINE.test(line)) {
        if (cycleFailed) dump();
        inCycle = true;
      }
      ring.push(line);
      if (level === 'normal' && (WATCH_PROGRESS_LINE.test(line) || (!ownLine && isCdkFailureLine(line)))) {
        if (from === 'stderr') console.error(`[CDK Watch] ${line.trim()}`);
        else (progressToStderr() ? console.error : console.log)(`[CDK Watch] ${line.trim()}`);
      }
      if (/^\s*❌/.test(line)) {
        dump();
        return;
      }
      if (WATCH_CYCLE_DONE_LINE.test(line)) {
        clearIdle();
        cycleFailed = false;
        inCycle = false;
      } else if (inCycle && !ownLine && isCdkFailureLine(line)) {
        cycleFailed = true;
      }
      if (cycleFailed) {
        clearIdle();
        idleTimer = setTimeout(dump, failureIdleMs);
        idleTimer.unref();
      }
    };
    stream.setEncoding('utf-8');
    stream.on('data', (chunk: string) => {
      for (const line of assembler.push(chunk)) handle(line);
    });
    stream.on('end', () => {
      for (const line of assembler.flush()) handle(line);
    });
  };
  relay(child.stdout, 'stdout');
  relay(child.stderr, 'stderr');
  child.once('exit', (code) => {
    clearIdle();
    if (options.stopping?.() || code === 0) return;
    dump();
  });
}
