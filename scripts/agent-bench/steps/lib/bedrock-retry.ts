// Bedrock invoke-layer retry PRIMITIVES — thin typed re-export.
//
// The pure logic (backoff budget, throttle/transient classifier, deep error
// describer, cause-chain walk) now lives in ./bedrock-retry.mjs so the bench
// unit suite (steps/lib/*.test.mjs, run via `node --test`) can import and
// exercise `isRetryableModelError` — the load-bearing retry-vs-give-up decision
// — directly; a .test.mjs cannot import a .ts. The builder (2-agent-run.ts) and
// judge (4-judge.ts) keep importing everything from THIS module unchanged, so
// runtime behavior is byte-identical — this file only adds the .ts type surface.
export {
	INVOKE_BACKOFF_MS,
	INVOKE_MAX_ATTEMPTS,
	describeModelError,
	errorChain,
	isRetryableModelError,
	sleep,
} from './bedrock-retry.mjs';

// One node of an error's `cause` chain (the shape errorChain yields). Preserved
// as an exported type for API-compat; the runtime walk lives in the .mjs.
export interface ErrorNode {
	name?: unknown;
	message?: unknown;
	$fault?: unknown;
	$metadata?: { httpStatusCode?: number; requestId?: string };
	cause?: unknown;
}
