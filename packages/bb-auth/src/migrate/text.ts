// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Text helpers for `bb-auth migrate`: span edits applied to the original
 * source (so everything the codemod does not touch keeps its exact bytes,
 * comments and formatting), indentation, and a unified diff for `--dry-run`.
 */

/** Replace `[start, end)` of the original text with `text`. */
export interface Edit {
	start: number;
	end: number;
	text: string;
}

/** Thrown when two edits overlap — a codemod bug, never a user error. */
export class OverlappingEditError extends Error {
	override readonly name = 'OverlappingEditError';
}

/**
 * Apply non-overlapping edits. Pure insertions (`start === end`) at the same
 * position are kept in the order they were added.
 */
export function applyEdits(text: string, edits: readonly Edit[]): string {
	const sorted = edits.map((e, i) => ({ ...e, i })).sort((a, b) => a.start - b.start || a.end - b.end || a.i - b.i);
	let out = '';
	let cursor = 0;
	for (const e of sorted) {
		if (e.start < cursor) {
			throw new OverlappingEditError(
				`overlapping edits at ${e.start}: ${JSON.stringify(text.slice(e.start, e.end))} → ${JSON.stringify(e.text)}`,
			);
		}
		out += text.slice(cursor, e.start) + e.text;
		cursor = e.end;
	}
	return out + text.slice(cursor);
}

/** The offset of the start of the line containing `pos`. */
export function lineStart(text: string, pos: number): number {
	const nl = text.lastIndexOf('\n', pos - 1);
	return nl + 1;
}

/** The leading whitespace of the line containing `pos`. */
export function indentAt(text: string, pos: number): string {
	const start = lineStart(text, pos);
	const match = /^[ \t]*/.exec(text.slice(start));
	return match ? match[0] : '';
}

/** Whether only whitespace precedes `pos` on its line. */
export function startsLine(text: string, pos: number): boolean {
	return text.slice(lineStart(text, pos), pos).trim() === '';
}

/**
 * Re-indent the continuation lines of `value` (a source snippet whose first
 * line started on a line indented `from`) so they sit under `to`.
 */
export function reindent(value: string, from: string, to: string): string {
	if (from === to || !value.includes('\n')) return value;
	return value
		.split('\n')
		.map((line, i) => {
			if (i === 0) return line;
			if (line.startsWith(from)) return to + line.slice(from.length);
			return line;
		})
		.join('\n');
}

/** The newline style of `text`. */
export function newlineOf(text: string): string {
	return text.includes('\r\n') ? '\r\n' : '\n';
}

// ─── Unified diff ─────────────────────────────────────────────────────────

const MAX_LCS_CELLS = 25_000_000;

/**
 * A unified diff of two texts (3 lines of context), in the format `git diff`
 * and `patch` read. Falls back to one whole-file hunk for very large files.
 */
export function unifiedDiff(path: string, before: string, after: string): string {
	if (before === after) return '';
	const a = before.split('\n');
	const b = after.split('\n');
	const ops = diffLines(a, b);
	const header = `--- a/${path}\n+++ b/${path}\n`;
	const hunks: string[] = [];
	const context = 3;
	let i = 0;
	while (i < ops.length) {
		while (i < ops.length && ops[i]?.op === ' ') i++;
		if (i >= ops.length) break;
		let start = Math.max(0, i - context);
		let end = i;
		// Extend the hunk while changes are within 2*context of each other.
		while (end < ops.length) {
			if (ops[end]?.op !== ' ') {
				end++;
				continue;
			}
			let run = 0;
			while (end + run < ops.length && ops[end + run]?.op === ' ') run++;
			if (end + run >= ops.length || run > 2 * context) {
				end = Math.min(ops.length, end + context);
				break;
			}
			end += run;
		}
		const slice = ops.slice(start, end);
		const firstA = slice.find((o) => o.op !== '+')?.ai ?? ops[start]?.ai ?? 0;
		const firstB = slice.find((o) => o.op !== '-')?.bi ?? ops[start]?.bi ?? 0;
		const lenA = slice.filter((o) => o.op !== '+').length;
		const lenB = slice.filter((o) => o.op !== '-').length;
		hunks.push(
			`@@ -${lenA === 0 ? firstA : firstA + 1},${lenA} +${lenB === 0 ? firstB : firstB + 1},${lenB} @@\n` +
				slice.map((o) => `${o.op}${o.line}`).join('\n'),
		);
		start = end;
		i = end;
	}
	return `${header}${hunks.join('\n')}\n`;
}

interface DiffOp {
	op: ' ' | '-' | '+';
	line: string;
	/** Index in `a` of this line (or of the next `a` line, for an insertion). */
	ai: number;
	/** Index in `b` of this line (or of the next `b` line, for a deletion). */
	bi: number;
}

function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
	// Trim the common prefix and suffix, then LCS the middle.
	let pre = 0;
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
	const ma = a.slice(pre, a.length - suf);
	const mb = b.slice(pre, b.length - suf);
	const ops: DiffOp[] = [];
	for (let k = 0; k < pre; k++) ops.push({ op: ' ', line: a[k] ?? '', ai: k, bi: k });
	const n = ma.length;
	const m = mb.length;
	if (n * m > MAX_LCS_CELLS) {
		for (const [k, line] of ma.entries()) ops.push({ op: '-', line, ai: pre + k, bi: pre });
		for (const [k, line] of mb.entries()) ops.push({ op: '+', line, ai: pre + n, bi: pre + k });
	} else {
		const w = m + 1;
		const t = new Uint32Array((n + 1) * w);
		for (let x = n - 1; x >= 0; x--) {
			for (let y = m - 1; y >= 0; y--) {
				t[x * w + y] =
					ma[x] === mb[y]
						? (t[(x + 1) * w + y + 1] ?? 0) + 1
						: Math.max(t[(x + 1) * w + y] ?? 0, t[x * w + y + 1] ?? 0);
			}
		}
		let x = 0;
		let y = 0;
		while (x < n || y < m) {
			if (x < n && y < m && ma[x] === mb[y]) {
				ops.push({ op: ' ', line: ma[x] ?? '', ai: pre + x, bi: pre + y });
				x++;
				y++;
			} else if (y < m && (x >= n || (t[x * w + y + 1] ?? 0) > (t[(x + 1) * w + y] ?? 0))) {
				ops.push({ op: '+', line: mb[y] ?? '', ai: pre + x, bi: pre + y });
				y++;
			} else {
				ops.push({ op: '-', line: ma[x] ?? '', ai: pre + x, bi: pre + y });
				x++;
			}
		}
	}
	for (let k = 0; k < suf; k++) {
		ops.push({ op: ' ', line: a[a.length - suf + k] ?? '', ai: a.length - suf + k, bi: b.length - suf + k });
	}
	return ops;
}
