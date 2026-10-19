// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded retry around PGlite's lazy WASM initialization.
 *
 * PGlite runs PostgreSQL in-process via a WASM module. Actual database
 * initialization (`initdb`) is deferred until the first query. Under memory
 * pressure — notably in CI, where several PGlite-backed dev servers boot
 * concurrently — that first query can hit a WASM `unreachable` trap in
 * `_pg_initdb`, which aborts the module. Left unhandled the abort propagates
 * out of the migration runner and kills the dev server mid-`runMigrations`.
 *
 * The trap is non-deterministic and an aborted WASM instance is unrecoverable,
 * so the only reliable mitigation is to discard the dead instance and boot a
 * fresh one. {@link initializePgliteWithRetry} forces initialization via a
 * probe query and, on an `unreachable` trap, closes the dead instance and
 * recreates it, up to a bounded number of attempts.
 *
 * This module is intentionally PGlite-agnostic (it relies only on the
 * structural {@link PgliteLike} shape) so `data-common` need not depend on
 * `@electric-sql/pglite`.
 */

/**
 * Minimal structural view of a PGlite instance used by the init retry. Kept
 * pglite-agnostic so `data-common` need not depend on `@electric-sql/pglite`.
 *
 * @internal
 */
export interface PgliteLike {
  /** Run a SQL statement; used only for the `SELECT 1` init probe. */
  query(sql: string, params?: unknown[]): Promise<unknown>;
  /** Release the instance and its underlying WASM resources. */
  close(): Promise<void>;
}

/**
 * Tuning options for {@link initializePgliteWithRetry}.
 *
 * @internal
 */
export interface PgliteInitRetryOptions {
  /** Maximum init attempts, including the first. Default 3. */
  maxAttempts?: number;
  /** Base backoff between attempts in ms; scales linearly by attempt number. Default 150. */
  backoffMs?: number;
  /**
   * Classifies whether a caught error is a retryable WASM init trap.
   * Defaults to {@link isPgliteUnreachableTrap}.
   */
  isRetryable?: (error: unknown) => boolean;
  /** Invoked before each recreate+retry with the failed attempt number and its error. */
  onRetry?: (attempt: number, error: unknown) => void;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Matches the specific ways a PGlite WASM `_pg_initdb` abort surfaces:
 *  - V8/Node:            `RuntimeError: unreachable` (optionally `... executed`)
 *  - other engines:      `wasm trap: unreachable`
 *  - Emscripten runtime: `Aborted(<reason>)` — the reason is often non-empty
 *    under memory pressure (`Aborted(Cannot enlarge memory arrays…)`,
 *    `Aborted(OOM)`), which is exactly the case this retry exists for, so we
 *    match the `Aborted(` prefix rather than only the empty `Aborted()` form.
 *
 * Deliberately narrower than a bare `/unreachable/i`: the word "unreachable" is
 * common (helpers like `assertUnreachable`, "unreachable host" messages), so we
 * require it next to a trap-context token. This keeps a stray "unreachable" in
 * an unrelated failure's message or stack from being misclassified as retryable.
 * (Matching the `Aborted(` prefix is safe here because this only ever runs
 * against the fixed `SELECT 1` init probe, never arbitrary user-query errors.)
 */
const PGLITE_INIT_TRAP_RE = /RuntimeError:\s*unreachable\b|wasm trap:\s*unreachable\b|\bAborted\(/i;

/**
 * Return true when an error looks like a PGlite WASM `unreachable` init trap.
 *
 * The trap surfaces as one of the {@link PGLITE_INIT_TRAP_RE} signatures,
 * sometimes only visible in the stack or a nested `cause`. This walks the
 * message, stack, and cause chain, guarding against cyclic causes.
 *
 * The real V8/Node trap arrives as a `RuntimeError` whose `.message` is just
 * `"unreachable"` (the `RuntimeError:` prefix only appears in `.stack`, via
 * `Error.prototype.toString`). So we also treat a `RuntimeError` named error
 * whose message contains `unreachable` as a trap — this catches it without
 * depending on the stack surviving intact, and stays just as narrow because a
 * plain `Error` (the `assertUnreachable` / "host unreachable" cases) never has
 * `name === 'RuntimeError'`.
 *
 * Scope: this classifier is ONLY valid for the init-probe path — the fixed
 * `SELECT 1` probe inside {@link initializePgliteWithRetry}, where the sole
 * plausible source of a trap signature is a WASM `_pg_initdb` abort. It must
 * NOT be reused to classify arbitrary user-query errors.
 *
 * @internal
 */
export function isPgliteUnreachableTrap(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      if (
        PGLITE_INIT_TRAP_RE.test(current.message) ||
        (current.name === 'RuntimeError' && /unreachable/i.test(current.message)) ||
        (current.stack != null && PGLITE_INIT_TRAP_RE.test(current.stack))
      ) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      return PGLITE_INIT_TRAP_RE.test(String(current));
    }
  }
  return false;
}

/**
 * Force a PGlite instance through WASM initialization with a bounded retry that
 * recreates the instance on an `unreachable` trap.
 *
 * A side-effect-free `SELECT 1` probe triggers PGlite's deferred `initdb`. If
 * the probe traps, the dead instance is closed (best effort) and a fresh one is
 * built via `recreate`, after a linear backoff, until it succeeds or attempts
 * are exhausted. Non-retryable errors are rethrown immediately.
 *
 * @param initial - the already-constructed instance to initialize first
 * @param recreate - factory returning a fresh, fully-prepared instance. Because
 *   an `initdb` trap aborts BEFORE PGlite persists its data-dir markers, this
 *   factory may safely re-run data-directory recovery (e.g. quarantining a
 *   partially-written dir) on each recreate; that recovery composes with this
 *   retry without conflict.
 * @param options - retry tuning; see {@link PgliteInitRetryOptions}
 * @returns the initialized instance (differs from `initial` if it was recreated)
 * @throws the last error once attempts are exhausted, or immediately for a
 *   non-retryable error
 *
 * @internal
 */
export async function initializePgliteWithRetry<T extends PgliteLike>(
  initial: T,
  recreate: () => T | Promise<T>,
  options: PgliteInitRetryOptions = {},
): Promise<T> {
  // `?? 3` only defaults null/undefined, not NaN. Guard against NaN explicitly:
  // `Math.max(1, NaN)` is `NaN` and `attempt >= NaN` is always false, which would
  // turn a persistent trap into an unbounded close/recreate loop.
  const maxAttempts = Number.isFinite(options.maxAttempts)
    ? Math.max(1, Math.trunc(options.maxAttempts as number))
    : 3;
  const backoffMs = options.backoffMs ?? 150;
  const isRetryable = options.isRetryable ?? isPgliteUnreachableTrap;

  let instance = initial;
  for (let attempt = 1; ; attempt++) {
    try {
      await instance.query('SELECT 1');
      return instance;
    } catch (error) {
      // Classify BEFORE consulting the attempt budget, so cleanup is uniform:
      // a non-retryable error is always rethrown untouched (we never close an
      // instance we haven't diagnosed as a dead WASM trap). This also means
      // maxAttempts === 1 no longer closes on an unrelated, non-trap failure.
      if (!isRetryable(error)) throw error;
      // Retryable init trap: the WASM instance is aborted and unrecoverable, so
      // close it (best effort) to free its memory — whether or not we retry.
      try {
        await instance.close();
      } catch {
        // A trapped WASM instance may itself fail to close cleanly; ignore.
      }
      // Out of attempts: give up after having closed the dead instance above.
      if (attempt >= maxAttempts) throw error;
      options.onRetry?.(attempt, error);
      if (backoffMs > 0) await delay(backoffMs * attempt);
      // The factory does real work (mkdirSync, new PGlite(...)), so it can throw
      // (ENOSPC/EACCES/construction failure). If it does, surface it as a
      // recreate failure while preserving the original init trap as the cause,
      // so debugging reflects "PGlite kept trapping" rather than only the
      // secondary recreate error.
      try {
        instance = await recreate();
      } catch (recreateError) {
        throw new Error(
          `Failed to recreate PGlite after an init trap: ${
            recreateError instanceof Error ? recreateError.message : String(recreateError)
          }`,
          { cause: error },
        );
      }
    }
  }
}


/**
 * Marker string a mock Database logs when an eager migration run dies on a
 * PGlite WASM init trap, so the data layer is up-but-broken (every query will
 * reject until migrations re-run). It is a STABLE, UNIQUE token — not prose —
 * so two very different consumers can key on it without a fuzzy match:
 *
 *  - a developer greps the dev-server log for it, and
 *  - the agent-bench scorer (`scripts/agent-bench/steps/lib/scoring.mjs`)
 *    reclassifies the cell as a harness (infra) failure rather than counting
 *    the WASM-memory crash against the agent under test.
 *
 * The scorer reads this exact literal (it is a dependency-free `.mjs` and cannot
 * import this module), so the two are coupled by VALUE: a drift test in
 * `scoring.test.mjs` asserts the scorer's copy equals this constant. Changing
 * the text here is a breaking change to that contract — update both together.
 */
export const PGLITE_DATA_LAYER_UNAVAILABLE_SENTINEL = '[bb-data] PGlite init trap: data layer unavailable';

/**
 * Attach a logging handler to an EAGER, unawaited initialization promise so a
 * rejection cannot escape as an unhandled rejection (which, in a mock Database
 * constructor, terminates the whole `npm run dev` process). The returned promise
 * is the ORIGINAL `promise` untouched — callers still `await` it through their
 * ready-gate, so the same rejection reaches every query as a branded error.
 *
 * On a PGlite WASM init trap specifically, the logged line carries
 * {@link PGLITE_DATA_LAYER_UNAVAILABLE_SENTINEL} and an actionable message
 * (the raw `Aborted(...)` cause is logged alongside, because the bb-logger
 * serializer keeps `name/message/stack` but DROPS `Error.cause`), and the
 * handler reports the trap to `onTrap` so the caller can clear its cached
 * promise and let the next query re-run idempotent migrations. A non-trap
 * failure (e.g. a bad `.env.local` AppSetting) is logged plainly and is NOT
 * reported as a trap, so it is not retried.
 *
 * @param promise - the eager init/migrations promise to guard
 * @param log - a logger with an `error(msg, meta)` method
 * @param label - short human label for the log line (e.g. `'Migrations failed'`)
 * @param onTrap - invoked (once) only when the rejection is a PGlite init trap
 * @returns the same `promise`, so the caller can store/await it unchanged
 */
export function trackEager<T>(
  promise: Promise<T>,
  log: { error: (message: string, meta?: Record<string, unknown>) => void },
  label: string,
  onTrap?: () => void,
): Promise<T> {
  promise.catch((error: unknown) => {
    const cause = (error as { cause?: unknown })?.cause;
    if (isPgliteUnreachableTrap(error)) {
      log.error(
        `${label}: ${PGLITE_DATA_LAYER_UNAVAILABLE_SENTINEL} (WASM memory). ` +
          'Database queries will fail until migrations re-run; restart the dev server if this persists.',
        { error, cause: cause ?? String(error) },
      );
      onTrap?.();
    } else {
      log.error(label, { error, cause: cause ?? undefined });
    }
  });
  return promise;
}

/**
 * Marker string a mock Database logs when a migration RE-RUN succeeds after a
 * prior PGlite WASM init trap — i.e. the up-but-broken data layer HEALED
 * (transient memory pressure eased, idempotent migrations re-applied, queries
 * work again). Like {@link PGLITE_DATA_LAYER_UNAVAILABLE_SENTINEL} it is a
 * STABLE, UNIQUE token, and it is the CAUSAL companion to that sentinel: the
 * agent-bench scorer only treats the data layer as "down when the tests ran"
 * when an unavailable sentinel is NOT followed by a recovery marker. Without
 * this, a transient trap that recovered on the first test request would be
 * wrongly excluded (and an agent bug behind it hidden). The scorer reads this
 * exact literal (dependency-free `.mjs`, cannot import), so a drift test in
 * `scoring.test.mjs` pins the two together — change both or neither.
 */
export const PGLITE_DATA_LAYER_RECOVERED_SENTINEL = '[bb-data] PGlite init trap: data layer recovered';

/**
 * Log {@link PGLITE_DATA_LAYER_RECOVERED_SENTINEL} to mark that a migration
 * re-run (triggered by a caller clearing its cache after a prior trap) has now
 * succeeded. Call this ONLY on the success of a RETRY run — never on the first
 * eager run — so the marker's presence always implies a preceding
 * unavailable sentinel. Logged at `error` level deliberately: it is the single
 * logger method every bb-logger `ChildLogger` is guaranteed to expose, and the
 * marker must never throw on the heal path (a throw here would reject the
 * re-run and leave the data layer wrongly wedged). The LEVEL carries no meaning
 * for the bench scorer — it greps the fixed literal, not the level.
 *
 * @param log - a logger with an `error(msg, meta)` method
 * @param label - short human label (e.g. `'Migrations re-ran'`)
 */
export function logRecovery(
  log: { error: (message: string, meta?: Record<string, unknown>) => void },
  label: string,
): void {
  log.error(`${label}: ${PGLITE_DATA_LAYER_RECOVERED_SENTINEL} (migrations re-applied; queries will succeed).`);
}
