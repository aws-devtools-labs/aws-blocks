// Shared Bedrock invoke-layer retry primitives for the bench steps (pure logic).
//
// Both model-calling steps — the builder (2-agent-run.ts) and the judge
// (4-judge.ts) — call `agent.invoke()` against Amazon Bedrock and must survive
// the account-wide tokens-per-minute (TPM) throttle. When many matrix cells hit
// InvokeModelWithResponseStream at once, Bedrock returns a throttle that Strands
// surfaces as `ModelThrottledError` or a bare `ModelError` ("Too many tokens,
// please wait before trying again."). That is transient: a short backoff-and-
// retry clears it. This module is the single source of truth for:
//   - the backoff budget (attempts + delays),
//   - which failures are retryable (throttle/transient) vs. terminal,
//   - a deep, cause-chain-aware error describer so the real AWS class is visible.
//
// The AWS-SDK-layer adaptive retry (`clientConfig: { maxAttempts, retryMode }`
// on the BedrockModel) is a complementary, lower layer and is set inline at each
// call site; this module is the APPLICATION-level loop wrapped around invoke().
//
// This is a plain .mjs (not .ts) on purpose: `isRetryableModelError` is the
// load-bearing decision for whether a throttled invoke retries or gives up, and
// the bench unit suite runs under bare `node --test steps/lib/*.test.mjs` — which
// can import this module directly but cannot import a .ts. The sibling
// bedrock-retry.ts is a thin typed re-export so the builder/judge imports stay
// unchanged. Types are carried via JSDoc (matching scoring.mjs's convention).
import {
	ContextWindowOverflowError,
	MaxTokensError,
	ModelError,
	ModelThrottledError,
	StructuredOutputError,
} from '@strands-agents/sdk';

// invoke-layer retry budget: the initial attempt + up to 4 retries (5 tries
// total), only on throttle/transient model failures (never a schema-validation
// failure — that is a real grading outcome). Backoff is exponential with jitter
// applied at the call site; the values are sized to sit comfortably inside each
// step's wall-clock cap even if every retry is exhausted.
export const INVOKE_MAX_ATTEMPTS = 5;
export const INVOKE_BACKOFF_MS = [5_000, 15_000, 40_000, 90_000];

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
	return new Promise((res) => setTimeout(res, ms));
}

// One node of an error's `cause` chain. Strands wraps the underlying AWS SDK
// exception as `cause`, which carries the real name/$metadata we want to see.
/**
 * @typedef {object} ErrorNode
 * @property {unknown} [name]
 * @property {unknown} [message]
 * @property {unknown} [$fault]
 * @property {{ httpStatusCode?: number, requestId?: string }} [$metadata]
 * @property {unknown} [cause]
 */

// Walk the `cause` chain (bounded + cycle-safe) so both the throttle classifier
// and the deep describer can inspect every wrapped layer, not just the top one.
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

// AWS exception names / HTTP statuses that mark a Bedrock failure as transient
// (worth retrying) rather than deterministic.
const TRANSIENT_NAME_RE =
	/throttl|toomanyrequests|too many (tokens|requests)|serviceunavailable|service_unavailable|internalserver|internalfailure|modelstream|modeltimeout|modelnotready|requesttimeout|timeouterror|partialresult|503|429/i;

// True when a model-call failure is a throttle/transient class worth retrying.
// A StructuredOutputError (model wouldn't emit a schema-valid grade) is a REAL
// outcome and is never retried; ContextWindowOverflowError / MaxTokensError are
// deterministic for a given input so retrying cannot help.
/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetryableModelError(err) {
	if (err instanceof StructuredOutputError) return false;
	if (err instanceof ContextWindowOverflowError || err instanceof MaxTokensError) return false;
	if (err instanceof ModelThrottledError) return true;
	// A bare ModelError almost always wraps a transient mid-stream AWS exception
	// (this is the "ModelError: Too many tokens" / "[object Object]" case).
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

// Deep error description for an invoke failure. A plain top-level describe only
// sees the outer wrapper, which for a wrapped Bedrock error is often
// "ModelError: [object Object]" — masking the real AWS class. This surfaces each
// layer's name, message, $fault and $metadata (httpStatusCode/requestId) so a
// future run shows the actual throttle/transient class in result.json.
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
