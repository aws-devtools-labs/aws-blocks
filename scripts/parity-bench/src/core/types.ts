// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The parity bench's contract (see ../../README.md): the catalog's case shape,
 * what a probe reports, and the recording format every reader and writer shares.
 * Types only, so pure catalogs and browser-side runners can import it.
 */

export type ParityCategory = 'limits' | 'errors' | 'consistency' | 'async' | 'security';

/** JSON-serializable case parameters; each pack narrows them in its runner. */
export type CaseParams = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Turns a case into a slider: instead of one fixed run, the driver searches
 * `[min, max]` of the integer param `param` for the first value where the block
 * stops succeeding, in each environment, and compares the breakpoints.
 */
export interface SweepSpec {
	/** The `params` key the sweep varies. The case's own value for it is ignored. */
	readonly param: string;
	readonly min: number;
	readonly max: number;
	/** What the value counts, e.g. `rows`, `bytes`, `items`, `seconds`. */
	readonly unit: string;
	/** The limit AWS documents (last value that should still succeed), when there is one. Cite it in `source`. */
	readonly documented?: number;
}

export interface ParityCase {
	/** Stable id: `<pack>.<capability>.<entry point>.<condition>`. Never reuse an id for a different behavior. */
	readonly id: string;
	/** Which pack's runner executes this case. */
	readonly pack: string;
	/** Package name of the Building Block under test. */
	readonly block: string;
	readonly category: ParityCategory;
	readonly description: string;
	/** Where the expectation comes from — an AWS doc URL, or a README/DESIGN.md line. Every case cites one. */
	readonly source: string;
	readonly params: CaseParams;
	/** Present on a slider case; see {@link SweepSpec}. */
	readonly sweep?: SweepSpec;
}

export interface ProbeError {
	readonly name: string;
	readonly httpStatus?: number;
	/** First `code` found down the error's `cause` chain, e.g. a PostgreSQL SQLSTATE such as `54000`. */
	readonly causeCode?: string;
}

/** What a probe observed. Errors keep only their wire-visible shape plus a driver code, never a message. */
export type ProbeOutcome =
	| { readonly status: 'ok'; readonly value: unknown }
	| { readonly status: 'error'; readonly error: ProbeError }
	| { readonly status: 'setup-failed'; readonly error: ProbeError };

export interface ProbeRun {
	readonly outcome: ProbeOutcome;
	readonly durationMs: number;
	/** Whether everything the case created was removed again. */
	readonly cleanup: 'ok' | 'failed';
}

export interface ProbeResult extends ProbeRun {
	readonly caseId: string;
}

/** A pack's runner: executes one of its own cases (with a sweep value already applied) against the real block. */
export type ProbeRunner = (c: ParityCase) => Promise<ProbeRun>;

/** The client-side view of a stack's `probe` namespace. */
export interface ProbeClient {
	listCases(): Promise<readonly ParityCase[]>;
	run(caseId: string): Promise<ProbeResult>;
	attempt(caseId: string, value: number): Promise<ProbeResult>;
}

// ── Recording format (one JSON object per line in `<dir>/<process>.jsonl`) ──

/** A recorded error: its wire-visible name and HTTP status, plus a truncated message. */
export interface RecordedError {
	name: string;
	status?: number;
	message?: string;
}

export type RecordedOutcome = { ok: true; value: unknown } | { ok: false; error: RecordedError };

/** One client call an e2e suite made, captured by the recorder. */
export interface CallRecord {
	kind: 'call';
	env: string;
	process: string;
	test: string;
	seq: number;
	method: string;
	args: unknown[];
	outcome: RecordedOutcome;
	ms: number;
}

/** One fixed probe case. */
export interface ProbeRecord {
	kind: 'probe';
	env: string;
	block: string;
	caseId: string;
	outcome: ProbeOutcome;
	cleanup: string;
	ms: number;
}

/** One slider case: where the block stopped succeeding in this environment. */
export interface SweepRecord {
	kind: 'sweep';
	env: string;
	block: string;
	caseId: string;
	unit: string;
	documented?: number;
	/** First failing value, or `null` when every value up to `max` succeeded. */
	breakpoint: number | null;
	max: number;
	/** How it fails at the breakpoint. */
	errorAtBreakpoint?: ProbeError;
	/** False when a value above the breakpoint succeeded again (the binary search's assumption broke). */
	monotonic: boolean;
	/** A harness problem (seeding or cleanup failed) aborted the sweep; the breakpoint is not trustworthy. */
	aborted?: string;
	attempts: { value: number; status: ProbeOutcome['status'] }[];
	ms: number;
}

/**
 * One HTTP exchange the e2e process made through `fetch`, captured by the edge
 * recorder: the RPC calls the generated client sends plus every raw request a
 * suite makes (auth redirects, CORS preflights, presigned URLs). It keeps what
 * a browser or HTTP client acts on and the e2e assertions rarely check: status,
 * app-level headers and cookie attributes. Values that differ per environment
 * (cookie values, origins, request ids) are never stored.
 */
export interface HttpRecord {
	kind: 'http';
	env: string;
	process: string;
	test: string;
	seq: number;
	/** HTTP method of the request. */
	method: string;
	/**
	 * What was called, comparable across environments: `rpc api.kvGet` for a JSON-RPC call,
	 * the app-origin path for a raw route (`/aws-blocks/auth/signin/google?code&state`),
	 * `<presigned>` for a presigned object URL, `<external>/path` for any other origin.
	 */
	route: string;
	/** Identifies the request body within one run, so the differ can collapse a poll loop. Never compared. */
	requestKey: string;
	/** An RPC request's params (snapshot, credential-like keys redacted): generated inputs the differ normalizes. Never compared. */
	params?: unknown;
	/** Response status, or `null` when the request failed before a response (`error` holds the name). */
	status: number | null;
	error?: string;
	/** Compared response headers, lower-case names, values normalized (see `COMPARED_HEADERS` in the recorder). */
	headers: Record<string, string>;
	/** Set-Cookie per cookie name: its attributes in canonical order, never its value. */
	cookies: Record<string, string>;
	/** Snapshot of a JSON response body on a non-RPC route (RPC bodies are in the matching `CallRecord`). */
	body?: unknown;
	ms: number;
}

export type ParityRecord = CallRecord | ProbeRecord | SweepRecord | HttpRecord;
