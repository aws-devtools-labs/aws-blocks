// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parity recorder — test plumbing, not customer code.
 *
 * When `E2E_PARITY_DIR` is set, every call the e2e suites make through the
 * generated client is appended as one JSON line (test name, call ordinal,
 * method, args, outcome, duration) to `<dir>/<process label>.jsonl`. Running the
 * same suite locally and against a deployed stack produces two recordings that
 * the differ (`../core/report.ts`) aligns by (test, ordinal) and diffs per Building Block.
 *
 * Unset, every export is a no-op and the client is returned unwrapped, so a
 * normal e2e run is unaffected.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach } from 'node:test';
import type { ParityRecord, RecordedError, RecordedOutcome } from '../core/types.js';

const DIR = process.env.E2E_PARITY_DIR;
const ENV = process.env.BLOCKS_TEST_ENV || 'local';

export const parityRecording = !!DIR;

let file: string | undefined;
let processLabel = 'main';
let currentTest = '(setup)';
let seq = 0;

/**
 * Start recording for this test process. Call once at module top level (it
 * registers a root `beforeEach`), with a label unique to the process — the
 * parent e2e run and each background-suite child write separate files.
 */
export function installParityRecorder(label: string): void {
	if (!DIR) return;
	processLabel = label;
	mkdirSync(DIR, { recursive: true });
	file = join(DIR, `${label}.jsonl`);
	writeFileSync(file, '');
	beforeEach((t) => {
		// Hooks receive the test's own context; `fullName` is the ' > '-joined describe path.
		currentTest = 'fullName' in t ? t.fullName : t.name;
		seq = 0;
	});
}

export function writeRecord(record: ParityRecord): void {
	if (file) appendFileSync(file, `${JSON.stringify(record)}\n`);
}

// Values whose key looks credential-like are never written, only their length.
const SENSITIVE_KEY = /^(code|otp)$|token|secret|password|cookie|authorization|session|credential/i;
const MAX_STRING = 2000;

/** A JSON-safe snapshot: redacts credential-like keys, truncates long strings, survives cycles and live objects. */
export function snapshot(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
	if (typeof value === 'string') return value.length > MAX_STRING ? `<string:${value.length}>` : value;
	if (typeof value === 'undefined') return '<undefined>';
	if (typeof value === 'bigint') return `<bigint:${value}>`;
	if (typeof value === 'function') return '<function>';
	if (typeof value !== 'object') return `<${typeof value}>`;
	if (seen.has(value) || depth > 8) return '<cycle-or-deep>';
	seen.add(value);
	if (value instanceof Date) return '<date>';
	if (value instanceof Uint8Array) return `<bytes:${value.byteLength}>`;
	if (Array.isArray(value)) return value.map((v) => snapshot(v, depth + 1, seen));
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		// Live client objects (Transferables, streams): record the type, not the internals.
		return `<${value.constructor?.name ?? 'object'}>`;
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		out[k] = SENSITIVE_KEY.test(k) && v != null ? `<redacted:${String(v).length}>` : snapshot(v, depth + 1, seen);
	}
	return out;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
	return typeof v === 'object' && v !== null && 'then' in v && typeof v.then === 'function';
}

function recordError(e: unknown): RecordedError {
	if (!(e instanceof Error)) return { name: `<thrown ${typeof e}>` };
	const status = 'status' in e && typeof e.status === 'number' ? e.status : undefined;
	return {
		name: e.name,
		...(status === undefined ? {} : { status }),
		message: e.message.slice(0, 200),
	};
}

/**
 * Wrap a generated client namespace so each method call is recorded. Returns
 * `target` untouched when recording is off. A method's own return value — a
 * promise, an async iterable, a live object — is passed through unchanged.
 */
export function recordClient<T extends object>(target: T, namespace: string): T {
	if (!DIR) return target;
	return new Proxy(target, {
		get(obj, prop, receiver) {
			const member = Reflect.get(obj, prop, receiver);
			if (typeof member !== 'function' || typeof prop !== 'string') return member;
			return (...args: unknown[]) => {
				const base = { kind: 'call' as const, env: ENV, process: processLabel, test: currentTest, seq: seq++ };
				const method = `${namespace}.${prop}`;
				const started = performance.now();
				const finish = (outcome: RecordedOutcome) =>
					writeRecord({ ...base, method, args: args.map((a) => snapshot(a)), outcome, ms: Math.round(performance.now() - started) });
				let result: unknown;
				try {
					result = member.apply(obj, args);
				} catch (e) {
					finish({ ok: false, error: recordError(e) });
					throw e;
				}
				if (isThenable(result)) {
					return Promise.resolve(result).then(
						(v) => {
							finish({ ok: true, value: snapshot(v) });
							return v;
						},
						(e: unknown) => {
							finish({ ok: false, error: recordError(e) });
							throw e;
						},
					);
				}
				finish({ ok: true, value: snapshot(result) });
				return result;
			};
		},
	});
}
