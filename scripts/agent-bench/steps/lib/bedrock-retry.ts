// Bedrock invoke-layer retry primitives — thin typed re-export. The pure logic lives in
// ./bedrock-retry.mjs so the .test.mjs suite can import it directly (a .test.mjs can't import .ts);
// this file only adds the .ts type surface, runtime behavior is byte-identical.
export {
	INVOKE_BACKOFF_MS,
	INVOKE_MAX_ATTEMPTS,
	describeModelError,
	errorChain,
	isRetryableModelError,
	nextBackoffMs,
	sleep,
} from './bedrock-retry.mjs';

// One node of an error's `cause` chain (the shape errorChain yields); the runtime walk is in the .mjs.
export interface ErrorNode {
	name?: unknown;
	message?: unknown;
	$fault?: unknown;
	$metadata?: { httpStatusCode?: number; requestId?: string };
	cause?: unknown;
}
