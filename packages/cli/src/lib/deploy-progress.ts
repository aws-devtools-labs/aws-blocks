// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Turns the CDK CLI's raw deploy stream into curated, Blocks-branded progress.
 *
 * `blocks deploy` / `blocks sandbox` run `cdk deploy`, which emits one line per
 * CloudFormation resource transition. The exact shape depends on the flags:
 *
 *   production (`--progress events --ci`):
 *     MyStack | 3/10 | 10:04:33 AM | CREATE_IN_PROGRESS | AWS::Lambda::Function | Handler
 *   sandbox (default event stream):
 *     bb-telemetry-xyz |  12 | 07:49:18 | CREATE_IN_PROGRESS | AWS::Lambda::Function | Handler
 *
 * The first carries an `N/M` counter (done / total); the second carries a
 * single running counter and no total. At Normal verbosity a user wants neither
 * firehose, but they also do not want silence for the multi-minute
 * CloudFormation phase (the "is it hung?" problem). This reporter sits between
 * the CDK stream and the terminal and translates it into a small set of
 * milestones plus a single live progress indicator:
 *
 *   - Synthesizing app...
 *   - Deploying to AWS  [####........]  12 resources   (one redrawn line on a TTY)
 *   - Deploy finished -- 40 resources in 1m 48s
 *
 * It counts `*_COMPLETE` transitions itself, so it works whether or not the
 * stream carries a total. Raw CDK lines are NOT forwarded at Normal level; only
 * the interpreted milestones are. Errors, failures and rollback transitions are
 * always surfaced verbatim (hiding a failure reason would be worse than noise).
 * At Verbose/Debug the deploy path bypasses this reporter entirely and streams
 * the raw output, so `--verbose` is still the escape hatch for full CDK logs.
 *
 * The reporter is a pure {@link OutputSink}: it is driven by `write(line)` and
 * emits to a target sink, with `isTty`/`now` injected so it is deterministic in
 * tests. Call {@link ProgressReporter.finish} when the stream ends to flush the
 * closing line.
 */

import { type OutputSink, filteredSink } from './stream-filter.js';
import { formatElapsed } from './deploy-stream.js';
import { LogLevel } from '../logger.js';

/** A CDK event line, parsed into the bits we report on. */
export interface CdkEvent {
	/** The running counter CDK prints (completed-so-far). */
	counter: number;
	/** Total resources, when the line carries an `N/M` counter; else `null`. */
	total: number | null;
	/** The CloudFormation status token, e.g. `CREATE_IN_PROGRESS`. */
	status: string;
	/** True when the status is a resource `*_COMPLETE` transition. */
	complete: boolean;
}

// A CDK resource-event line looks like:
//   <stack> | <counter> | <time> | <STATUS> | <Type> | <id...>
// where <counter> is either `N/M` (production, --progress events) or a single
// running number `N` (sandbox default). Match the leading `stack | counter |`
// shape, then the STATUS token, so both formats parse.
const CDK_EVENT = /^\S.*?\|\s*(\d+)(?:\s*\/\s*(\d+))?\s*\|.*?\b([A-Z]+_[A-Z_]+)\b/;

/** Parse a CDK resource-event line, or `null` if it is not one. */
export function parseCdkEvent(line: string): CdkEvent | null {
	const m = CDK_EVENT.exec(line);
	if (!m) return null;
	const status = m[3];
	return {
		counter: Number(m[1]),
		total: m[2] === undefined ? null : Number(m[2]),
		status,
		complete: /_COMPLETE$/.test(status),
	};
}

/** A line that marks the deploy as finished (stack-level, not per-resource). */
function isDeployDone(line: string): boolean {
	return (
		/^\s*\u2705\s/.test(line) || // CDK's final "✅  StackName"
		/^\s*Outputs:/.test(line) ||
		/\u2728\s+Deployment time:/.test(line) || // "✨  Deployment time: 108s"
		/\u2728\s+Total time:/.test(line)
	);
}

/** A line that reports a failure or rollback -- always surfaced verbatim. */
function isFailure(line: string): boolean {
	return (
		/\bROLLBACK\b/.test(line) ||
		/_FAILED\b/.test(line) ||
		/\b(error|failed|failure|exception)\b/i.test(line) ||
		/^\s*\u274c/.test(line)
	);
}

/** Noise we never want even as a milestone: SDK/node deprecation warnings. */
function isIgnorableNoise(line: string): boolean {
	return (
		/NodeVersionSupportWarning/.test(line) ||
		/trace-warnings/.test(line) ||
		/^\(node:\d+\)/.test(line) ||
		/AWS SDK for JavaScript/.test(line) ||
		/^\s*More information can be found/.test(line) ||
		/require node >=/.test(line) ||
		/security updates please upgrade/.test(line) ||
		/versions published after/.test(line) ||
		/Stack ARN:/.test(line)
	);
}

/** A synth/bundling phase marker (pre-CloudFormation). */
function isSynthPhase(line: string): boolean {
	return (
		/\u2728\s+Synthesis time:/.test(line) ||
		/\b(synthesi|bundling|building assets?)\b/i.test(line)
	);
}

export interface ProgressReporterOptions {
	/** Whether the target is an interactive terminal (enables in-place redraw). */
	isTty?: boolean;
	/** Injected clock for deterministic tests. */
	now?: () => number;
	/** Label shown in milestone lines. Defaults to `Deploying to AWS`. */
	label?: string;
	/**
	 * The action word used in the start/finish lines: `deploy` -> "🚀 … / ✅
	 * Deploy finished", `destroy` -> "🗑️ … / ✅ Destroy finished". Defaults to
	 * `deploy`.
	 */
	verb?: 'deploy' | 'destroy';
}

/** A reporter sink plus a {@link ProgressReporter.finish} to flush the summary. */
export interface ProgressReporter extends OutputSink {
	/** Flush the terminal summary. Call once the CDK stream has ended. */
	finish(ok: boolean): void;
}

const SPINNER = ['\u25d0', '\u25d3', '\u25d1', '\u25d2'];

/**
 * Build a progress reporter that translates the raw CDK deploy stream into
 * curated milestones + a single live progress indicator, written to `target`.
 *
 * On a TTY the progress line is redrawn in place (carriage return, no newline)
 * so it reads as one updating line; when piped (no TTY) it emits a throttled
 * update instead, so a `tee`/log file still shows forward motion without a
 * redraw it cannot render.
 */
export function createCdkProgressReporter(
	target: OutputSink,
	options: ProgressReporterOptions = {},
): ProgressReporter {
	const { isTty = false, now = Date.now, label = 'Deploying to AWS', verb = 'deploy' } = options;
	const startedAt = now();

	// Verb-specific wording for the start milestone and the closing summary.
	const startIcon = verb === 'destroy' ? '\ud83d\uddd1\ufe0f' : '\ud83d\ude80';
	const finishedWord = verb === 'destroy' ? 'Destroy finished' : 'Deploy finished';
	const failedWord = verb === 'destroy' ? 'Destroy failed' : 'Deploy failed';
	const applyWord = verb === 'destroy' ? 'to remove' : 'to apply';

	let announcedSynth = false;
	let announcedDeploy = false;
	let total: number | null = null; // known only in the N/M (production) format
	let completed = 0; // resources we have seen reach *_COMPLETE
	let spin = 0;
	let liveLineOpen = false; // a TTY progress line is on screen (needs CR clear)
	let lastPipedKey = ''; // throttle piped updates to real changes

	/** Clear an in-place progress line so the next full line starts clean. */
	const clearLive = (): void => {
		if (liveLineOpen) {
			target.write('\r\x1b[K');
			liveLineOpen = false;
		}
	};

	/** Emit a newline-terminated milestone, clearing any live line first. */
	const milestone = (text: string): void => {
		clearLive();
		target.write(`${text}\n`);
	};

	const renderProgress = (): void => {
		// "done" is the completions we counted; prefer the stream's own counter
		// if it is further along (it can report completes we classified loosely).
		const done = completed;
		const plural = (n: number): string => (n === 1 ? '' : 's');
		if (isTty) {
			spin = (spin + 1) % SPINNER.length;
			let bar: string;
			let tail: string;
			if (total && total > 0) {
				const pct = Math.min(100, Math.round((done / total) * 100));
				const width = 20;
				const filled = Math.min(width, Math.round((pct / 100) * width));
				bar = '[' + '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled) + ']';
				tail = `${done}/${total} resources`;
			} else {
				// No total in this stream: show a determinate-count + elapsed instead
				// of a fake percentage bar.
				bar = '';
				tail = `${done} resource${plural(done)} \u00b7 ${formatElapsed(now() - startedAt)}`;
			}
			target.write(`\r\x1b[K${SPINNER[spin]} ${label}  ${bar}${bar ? '  ' : ''}${tail}`);
			liveLineOpen = true;
		} else {
			const key = total && total > 0 ? `${done}/${total}` : String(done);
			if (key !== lastPipedKey) {
				lastPipedKey = key;
				const tail =
					total && total > 0
						? `${done}/${total} resources`
						: `${done} resource${plural(done)}`;
				target.write(`   ${label}... ${tail}\n`);
			}
		}
	};

	return {
		write(chunk: string): unknown {
			for (const raw of chunk.split('\n')) {
				const line = raw.replace(/\r$/, '');
				if (line.trim() === '') continue;
				if (isIgnorableNoise(line)) continue;

				// Failures and rollbacks are never swallowed -- surface verbatim.
				if (isFailure(line)) {
					milestone(line.trim());
					continue;
				}

				const event = parseCdkEvent(line);
				if (event) {
					if (!announcedDeploy) {
						announcedDeploy = true;
						total = event.total;
						const scope =
							total && total > 0
								? ` -- ${total} resource${total === 1 ? '' : 's'} ${applyWord}`
								: '';
						milestone(`${startIcon} ${label}${scope}`);
					}
					if (event.total && (total === null || event.total > total)) {
						total = event.total;
					}
					// Count distinct completions. The single-counter format already
					// counts completes in `counter`; the N/M format puts completes in
					// `done` too. Take the max so we never go backwards.
					if (event.complete) completed = Math.max(completed, completed + 1);
					if (event.total !== null) completed = Math.max(completed, event.counter);
					else if (event.complete) completed = Math.max(completed, event.counter);
					renderProgress();
					continue;
				}

				// Pre-deploy synth/bundling phase: announce once, drop the detail.
				if (!announcedDeploy && isSynthPhase(line)) {
					if (!announcedSynth) {
						announcedSynth = true;
						milestone('\ud83d\udd27 Synthesizing app...');
					}
					continue;
				}

				// Stack-level completion marker: nudge the bar to full; the summary
				// is emitted by finish().
				if (isDeployDone(line) && announcedDeploy) {
					if (total && total > 0) completed = total;
					renderProgress();
				}
				// Everything else at Normal level is raw CDK chatter -- dropped.
			}
			return true;
		},

		finish(ok: boolean): void {
			clearLive();
			const elapsed = formatElapsed(now() - startedAt);
			if (ok) {
				if (announcedDeploy) {
					const n = total && total > 0 ? total : completed;
					target.write(
						`\u2705 ${finishedWord} -- ${n} resource${n === 1 ? '' : 's'} in ${elapsed}\n`,
					);
				}
				// No deploy events (no-op / nothing to deploy): stay silent; the
				// command prints the authoritative "deployed" line + URLs.
			} else {
				target.write(`\u274c ${failedWord} after ${elapsed}\n`);
			}
		},
	};
}

/**
 * The stdout + stderr wiring a CDK-driving command (deploy / sandbox / destroy)
 * hands to {@link runStreaming}, chosen by verbosity so every command behaves
 * the same:
 *
 * - **Normal / Quiet** -> a single {@link createCdkProgressReporter} fed by BOTH
 *   streams. The CDK CLI sends its event stream to stdout only under `--ci`
 *   (the production deploy path) and to **stderr** otherwise (the sandbox and
 *   destroy paths, which do not pass `--ci`). Feeding one shared reporter from
 *   both streams means the curated progress works regardless of which stream
 *   CDK chose, instead of silently showing nothing when the events land on the
 *   stream the reporter was not watching.
 * - **Verbose / Debug** -> {@link filteredSink} on each stream (a straight
 *   pass-through at Verbose), so the full raw CDK output is shown for debugging.
 *
 * Returns both sinks plus a `finish(ok)` the caller invokes once
 * {@link runStreaming} resolves (ok=true) or throws (ok=false), so the closing
 * summary line is flushed exactly once. At Verbose+ `finish` is a no-op.
 */
export function createDeployStreams(
	stdoutTarget: OutputSink,
	stderrTarget: OutputSink,
	level: LogLevel,
	options: ProgressReporterOptions = {},
): { stdout: OutputSink; stderr: OutputSink; finish(ok: boolean): void } {
	if (level >= LogLevel.Verbose) {
		return {
			stdout: filteredSink(stdoutTarget, level),
			stderr: filteredSink(stderrTarget, level),
			finish: () => {},
		};
	}
	// One reporter, written to the real stdout, fed by both child streams so an
	// event on EITHER drives the same progress line.
	const reporter = createCdkProgressReporter(stdoutTarget, options);
	return {
		stdout: reporter,
		stderr: reporter,
		finish: (ok: boolean) => reporter.finish(ok),
	};
}

/**
 * Back-compat single-stream helper (stdout only). Prefer
 * {@link createDeployStreams} so CDK events on stderr (sandbox/destroy, no
 * `--ci`) are not missed.
 */
export function createDeployStdout(
	target: OutputSink,
	level: LogLevel,
	options: ProgressReporterOptions = {},
): { sink: OutputSink; finish(ok: boolean): void } {
	if (level >= LogLevel.Verbose) {
		return { sink: filteredSink(target, level), finish: () => {} };
	}
	const reporter = createCdkProgressReporter(target, options);
	return { sink: reporter, finish: (ok: boolean) => reporter.finish(ok) };
}
