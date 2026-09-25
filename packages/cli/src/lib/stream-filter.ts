// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A verbosity-gated output layer for child-process streams — the CDK/npm/tsx
 * output produced by deploy, destroy, sandbox, sandbox:destroy and external
 * migrations. At Normal level it lets through only the lines a user cares about
 * — CloudFormation resource events, warnings, errors, and the runner's own
 * heartbeat/progress — and drops the raw tool chatter (asset publishing,
 * bundling, synth spam) that otherwise buries the signal. At Verbose (or above)
 * it is a pass-through: every line is relayed unchanged, so `--verbose` gives
 * the full raw stream for debugging.
 *
 * This closes the DX gap the vendored-scripts model could not: today
 * `stdio: 'inherit'` streams every byte to the terminal with no gating. Two
 * consumers share the predicate here: {@link filteredSink} wraps the streaming
 * `runStreaming` sink (live deploy), and `run-command.ts` uses
 * {@link keepAtNormalLine} to filter the captured output of synchronous
 * `runSync` calls — so EVERY command that shells out is gated the same way.
 */

import { LogLevel } from '../logger.js';

/** The minimal sink shape `runStreaming` writes to (matches its OutputSink). */
export interface OutputSink {
	write(chunk: string): unknown;
}

/**
 * Lines worth surfacing even at Normal level. CloudFormation event lines and
 * anything error/warn-shaped pass; the CDK progress noise does not. Kept
 * intentionally broad — when unsure, show the line (a false keep is a minor
 * annoyance; a false drop hides real signal).
 */
const KEEP_AT_NORMAL: RegExp[] = [
	// CloudFormation resource events: "CREATE_IN_PROGRESS", "UPDATE_COMPLETE", …
	/\b(CREATE|UPDATE|DELETE|IMPORT|ROLLBACK)_[A-Z_]+\b/,
	// CDK stack progress markers and outputs.
	/\b\d+\/\d+\b.*\|/, // "12/34 |" style progress with a resource
	/^\s*✅|^\s*❌|^\s*✨|^\s*⚠|Outputs:|Stack ARN:/,
	// Errors / failures / warnings anywhere in the line.
	/\b(error|failed|failure|exception|warn(ing)?)\b/i,
	// The runner's own heartbeat / progress lines.
	/still running after|Streaming CloudFormation|deploy keeps running/,
	// Migration progress (external-migrations-step).
	/\b(migrat|applied|pending)\b/i,
];

/**
 * True if a single line should be shown at Normal level. Exported so the
 * synchronous runner (`run-command.ts`) can filter captured output with the
 * same rules the streaming sink uses.
 */
export function keepAtNormalLine(line: string): boolean {
	if (line.trim() === '') return false; // drop blank noise at Normal
	return KEEP_AT_NORMAL.some((re) => re.test(line));
}

/**
 * Wrap a target sink so lines are gated by `level`. At `LogLevel.Verbose` and
 * above the wrapper is a straight pass-through. At Normal/Quiet, only
 * signal-bearing lines (see {@link KEEP_AT_NORMAL}) are written; everything
 * else is dropped. Errors are matched by shape, so error-level CDK output on
 * stderr still gets through even at Normal.
 *
 * `runStreaming` writes one line per `write()` call (it relays line by line),
 * so gating per-write is gating per-line.
 */
export function filteredSink(target: OutputSink, level: LogLevel): OutputSink {
	if (level >= LogLevel.Verbose) {
		return target; // pass-through: show the full raw stream
	}
	return {
		write(chunk: string): unknown {
			// A chunk is normally a single "line\n"; handle multi-line defensively.
			const kept = chunk
				.split('\n')
				.filter((line, i, arr) => {
					// Preserve a trailing empty segment only if it is the split artifact
					// of a final newline on an otherwise-kept chunk; drop standalone blanks.
					if (line === '' && i === arr.length - 1) return false;
					return keepAtNormalLine(line);
				});
			if (kept.length === 0) return true;
			return target.write(`${kept.join('\n')}\n`);
		},
	};
}
