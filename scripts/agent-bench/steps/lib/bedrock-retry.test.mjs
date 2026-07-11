// Unit tests for the Bedrock invoke-layer retry classifier (bedrock-retry.mjs). `isRetryableModelError`
// decides whether a throttled invoke RETRIES (throttle/transient) or GIVES UP (real outcome); these
// pin that boundary. Run under bare `node --test`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	ContextWindowOverflowError,
	MaxTokensError,
	ModelError,
	ModelThrottledError,
	StructuredOutputError,
} from '@strands-agents/sdk';
import {
	INVOKE_BACKOFF_MS,
	INVOKE_MAX_ATTEMPTS,
	describeModelError,
	errorChain,
	isRetryableModelError,
	nextBackoffMs,
} from './bedrock-retry.mjs';

// A minimal assistant Message for the MaxTokensError constructor — its second
// arg (partialMessage) is required by the type but irrelevant to the classifier.
const EMPTY_MESSAGE = { role: 'assistant', content: [] };

// Table-driven: [label, error value, expected isRetryableModelError result].
const CASES = [
	// --- retryable: Strands throttle / bare-model failures ---
	['ModelThrottledError', new ModelThrottledError('Too many tokens'), true],
	['bare ModelError ("Too many tokens…")', new ModelError('Too many tokens, please wait before trying again.'), true],
	['ModelThrottledError wrapping a cause', new ModelThrottledError('throttled', { cause: new Error('x') }), true],
	// --- retryable via cause-chain exception NAME (raw AWS SDK errors) ---
	['error named ThrottlingException', Object.assign(new Error('slow down'), { name: 'ThrottlingException' }), true],
	[
		'error whose CAUSE node is named ThrottlingException',
		new Error('outer', { cause: Object.assign(new Error('inner'), { name: 'ThrottlingException' }) }),
		true,
	],
	['error named TooManyRequestsException', Object.assign(new Error('rate'), { name: 'TooManyRequestsException' }), true],
	[
		'error named ServiceUnavailableException',
		Object.assign(new Error('unavail'), { name: 'ServiceUnavailableException' }),
		true,
	],
	// --- retryable via $metadata.httpStatusCode (429 / 5xx) ---
	['$metadata.httpStatusCode 429', Object.assign(new Error('rl'), { $metadata: { httpStatusCode: 429 } }), true],
	['$metadata.httpStatusCode 503', Object.assign(new Error('unavail'), { $metadata: { httpStatusCode: 503 } }), true],
	['$metadata.httpStatusCode 500', Object.assign(new Error('ise'), { $metadata: { httpStatusCode: 500 } }), true],
	[
		'429 buried on a CAUSE node',
		new Error('wrap', { cause: Object.assign(new Error('deep'), { $metadata: { httpStatusCode: 429 } }) }),
		true,
	],
	// --- NOT retryable: deterministic / real grading outcomes ---
	['StructuredOutputError', new StructuredOutputError('model emitted no schema-valid grade'), false],
	['ContextWindowOverflowError', new ContextWindowOverflowError('input exceeds context window'), false],
	['MaxTokensError', new MaxTokensError('hit max tokens', EMPTY_MESSAGE), false],
	['plain Error', new Error('boom'), false],
	[
		'ValidationException (400)',
		Object.assign(new Error('bad input'), { name: 'ValidationException', $metadata: { httpStatusCode: 400 } }),
		false,
	],
	[
		'AccessDeniedException (403)',
		Object.assign(new Error('denied'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }),
		false,
	],
	// --- non-object / empty inputs are never retryable (defensive) ---
	['null', null, false],
	['undefined', undefined, false],
	['string', 'nope', false],
];

describe('isRetryableModelError — throttle/transient ⇒ retry; deterministic/real ⇒ give up', () => {
	for (const [label, err, expected] of CASES) {
		it(`${expected ? 'RETRIES' : 'gives up on'}: ${label}`, () => {
			assert.equal(isRetryableModelError(err), expected);
		});
	}
});

// Pin that non-retryable ModelError subclasses stay terminal despite extending ModelError (while
// ModelThrottledError, also a subclass, stays retryable) — a naive instanceof check would retry them.
describe('ModelError subclass ordering (specific subclasses classified before the base)', () => {
	it('ContextWindowOverflowError / MaxTokensError extend ModelError yet are NOT retryable', () => {
		assert.ok(new ContextWindowOverflowError('x') instanceof ModelError);
		assert.ok(new MaxTokensError('x', EMPTY_MESSAGE) instanceof ModelError);
		assert.equal(isRetryableModelError(new ContextWindowOverflowError('x')), false);
		assert.equal(isRetryableModelError(new MaxTokensError('x', EMPTY_MESSAGE)), false);
	});
	it('ModelThrottledError extends ModelError and IS retryable', () => {
		assert.ok(new ModelThrottledError('x') instanceof ModelError);
		assert.equal(isRetryableModelError(new ModelThrottledError('x')), true);
	});
});

// errorChain + describeModelError moved with the classifier; pin their contracts.
describe('errorChain — bounded, cycle-safe cause-chain walk', () => {
	it('walks nested causes in order', () => {
		const inner = new Error('inner');
		const outer = new Error('outer', { cause: inner });
		const chain = errorChain(outer);
		assert.equal(chain.length, 2);
		assert.equal(chain[0], outer);
		assert.equal(chain[1], inner);
	});
	it('terminates on a self-referential cause cycle', () => {
		const e = new Error('loop');
		e.cause = e;
		assert.equal(errorChain(e).length, 1);
	});
	it('is bounded to 6 nodes even for a long chain', () => {
		let e = new Error('n0');
		for (let i = 1; i < 20; i++) e = new Error(`n${i}`, { cause: e });
		assert.equal(errorChain(e).length, 6);
	});
	it('returns [] for non-object inputs', () => {
		assert.deepEqual(errorChain(null), []);
		assert.deepEqual(errorChain('str'), []);
	});
});

describe('describeModelError — surfaces the real wrapped AWS class', () => {
	it('unmasks the cause chain (class + message + httpStatusCode)', () => {
		const inner = Object.assign(new Error('slow'), {
			name: 'ThrottlingException',
			$metadata: { httpStatusCode: 429 },
		});
		const outer = new ModelError('Too many tokens', { cause: inner });
		const desc = describeModelError(outer);
		assert.match(desc, /ModelError: Too many tokens/);
		assert.match(desc, /ThrottlingException/);
		assert.match(desc, /httpStatusCode:429/);
		assert.match(desc, / ← caused by /);
	});
	it('falls back to String(err) for a non-object input', () => {
		assert.equal(describeModelError('boom'), 'boom');
	});
});

// nextBackoffMs is the shared builder/judge backoff (base from the ladder + up to
// +25% jitter). Pin the [base, base*1.25) envelope and the ladder-exhausted /
// out-of-range fallback so both retry loops wait within their step budgets.
describe('nextBackoffMs — exponential base + bounded jitter', () => {
	it('stays within [base, base*1.25) for every ladder rung (sampled)', () => {
		for (let attempt = 1; attempt <= INVOKE_BACKOFF_MS.length; attempt++) {
			const base = INVOKE_BACKOFF_MS[attempt - 1];
			for (let i = 0; i < 200; i++) {
				const ms = nextBackoffMs(attempt);
				assert.ok(ms >= base, `attempt ${attempt}: ${ms} < base ${base}`);
				assert.ok(ms < base * 1.25, `attempt ${attempt}: ${ms} >= base*1.25 ${base * 1.25}`);
			}
		}
	});
	it('clamps to the last rung once the ladder is exhausted (attempt beyond length)', () => {
		const base = INVOKE_BACKOFF_MS[INVOKE_BACKOFF_MS.length - 1];
		const ms = nextBackoffMs(INVOKE_MAX_ATTEMPTS + 3);
		assert.ok(ms >= base && ms < base * 1.25);
	});
});
