// Shared Bedrock invoke-layer retry primitives for the bench steps (pure logic). Both the builder
// (2-agent-run.ts) and judge (4-judge.ts) invoke() against Bedrock and must survive the account TPM
// throttle (surfaced as ModelThrottledError or a bare ModelError "Too many tokens"), which is
// transient. Single source of truth for the backoff budget, the retryable/terminal classifier, and
// a cause-chain-aware error describer. Complements the lower AWS-SDK adaptive retry set at each call
// site. Plain .mjs (not .ts) so the `node --test` suite can import it directly; bedrock-retry.ts is
// a thin typed re-export. Types via JSDoc (matching scoring.mjs).
import {
	ContextWindowOverflowError,
	MaxTokensError,
	ModelError,
	ModelThrottledError,
	StructuredOutputError,
} from '@strands-agents/sdk';

// invoke-layer retry budget: initial attempt + up to 4 retries, only on throttle/transient failures.
// Exponential backoff (jitter applied at the call site), sized to fit inside each step's wall-clock cap.
export const INVOKE_MAX_ATTEMPTS = 5;
export const INVOKE_BACKOFF_MS = [5_000, 15_000, 40_000, 90_000];

// Backoff (ms) before the given 1-based retry: the exponential base (last value once exhausted) plus
// up to +25% jitter so concurrent cells don't re-hit Bedrock in lockstep.
/**
 * @param {number} attempt 1-based attempt number that is about to be retried
 * @returns {number}
 */
export function nextBackoffMs(attempt) {
	const base = INVOKE_BACKOFF_MS[attempt - 1] ?? INVOKE_BACKOFF_MS[INVOKE_BACKOFF_MS.length - 1] ?? 5_000;
	return base + Math.floor(Math.random() * base * 0.25);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
	return new Promise((res) => setTimeout(res, ms));
}

// One node of an error's `cause` chain (Strands wraps the AWS SDK exception as `cause`).
/**
 * @typedef {object} ErrorNode
 * @property {unknown} [name]
 * @property {unknown} [message]
 * @property {unknown} [$fault]
 * @property {{ httpStatusCode?: number, requestId?: string }} [$metadata]
 * @property {unknown} [cause]
 */

// Walk the `cause` chain (bounded + cycle-safe) so the classifier and describer see every layer.
/**
 * @param {unknown} err
 * @returns {ErrorNode[]}
 */
export function errorChain(err) {
	/** @type {ErrorNode[]} */
	const out = [];
	const seen = new Set();
	let cur = err;
	while (cur && typeof cur === 'object' && !seen.has(cur) && out.length < 6) {
		seen.add(cur);
		out.push(/** @type {ErrorNode} */ (cur));
		cur = /** @type {ErrorNode} */ (cur).cause;
	}
	return out;
}

// AWS exception names / HTTP statuses marking a Bedrock failure as transient (worth retrying).
const TRANSIENT_NAME_RE =
	/throttl|toomanyrequests|too many (tokens|requests)|serviceunavailable|service_unavailable|internalserver|internalfailure|modelstream|modeltimeout|modelnotready|requesttimeout|timeouterror|partialresult|503|429/i;

// True when a model-call failure is a throttle/transient class worth retrying. StructuredOutputError
// is a real grading outcome; ContextWindowOverflowError / MaxTokensError are deterministic — none retry.
/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetryableModelError(err) {
	if (err instanceof StructuredOutputError) return false;
	if (err instanceof ContextWindowOverflowError || err instanceof MaxTokensError) return false;
	if (err instanceof ModelThrottledError) return true;
	// A bare ModelError almost always wraps a transient mid-stream AWS exception.
	if (err instanceof ModelError) return true;
	// Fall back to the AWS exception name / HTTP status on the error or its cause.
	for (const node of errorChain(err)) {
		const name = typeof node.name === 'string' ? node.name : '';
		if (TRANSIENT_NAME_RE.test(name)) return true;
		const status = node.$metadata?.httpStatusCode;
		if (typeof status === 'number' && (status === 429 || status >= 500)) return true;
	}
	return false;
}

// Deep error description for an invoke failure: surfaces each cause-chain layer's name, message,
// $fault and $metadata, so the real AWS class shows through a "ModelError: [object Object]" wrapper.
/**
 * @param {unknown} err
 * @returns {string}
 */
export function describeModelError(err) {
	const nodes = errorChain(err);
	if (nodes.length === 0) return String(err);
	return nodes
		.map((n) => {
			const name = typeof n.name === 'string' && n.name ? n.name : 'Error';
			let msg;
			if (typeof n.message === 'string') {
				msg = n.message;
			} else {
				try {
					msg = JSON.stringify(n.message) ?? String(n.message);
				} catch {
					msg = String(n.message);
				}
			}
			const fault = n.$fault ? ` $fault=${String(n.$fault)}` : '';
			const status = n.$metadata?.httpStatusCode;
			const reqId = n.$metadata?.requestId;
			const metaParts = [
				typeof status === 'number' ? `httpStatusCode:${status}` : '',
				reqId ? `requestId:${reqId}` : '',
			].filter(Boolean);
			const meta = metaParts.length ? ` $metadata={${metaParts.join(',')}}` : '';
			return `${name}: ${msg}${fault}${meta}`;
		})
		.join(' ← caused by ');
}
