/**
 * True only in local/mock dev — i.e. NOT running inside a deployed Blocks Lambda.
 *
 * `BLOCKS_STACK_NAME` is injected into every deployed Blocks handler (sandbox
 * and production) by BlocksBackend and is unset against the local mock runtime,
 * so its absence is the framework's canonical "am I local?" signal (the
 * generated database connection resolver switches ports on the same variable).
 *
 * Use it to gate mock-only affordances — such as the OTP-surfacing helpers in
 * this demo — so a real verification code can never be captured, logged, or
 * returned from a deployed environment.
 */
export const isLocalDev = (): boolean => !process.env.BLOCKS_STACK_NAME;

/** Return `value` in local/mock dev; `null` in any deployed environment. */
export const localDevOnly = <T>(value: T): T | null => (isLocalDev() ? value : null);
