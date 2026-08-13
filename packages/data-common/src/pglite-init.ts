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
 *  - Emscripten runtime: `Aborted()` (e.g. `Aborted(). Build with -sASSERTIONS ...`)
 *
 * Deliberately narrower than a bare `/unreachable/i`: the word "unreachable" is
 * common (helpers like `assertUnreachable`, "unreachable host" messages), so we
 * require it next to a trap-context token. This keeps a stray "unreachable" in
 * an unrelated failure's message or stack from being misclassified as retryable.
 */
const PGLITE_INIT_TRAP_RE = /RuntimeError:\s*unreachable\b|wasm trap:\s*unreachable\b|\bAborted\(\)/i;

/**
 * Return true when an error looks like a PGlite WASM `unreachable` init trap.
 *
 * The trap surfaces as one of the {@link PGLITE_INIT_TRAP_RE} signatures,
 * sometimes only visible in the stack or a nested `cause`. This walks the
 * message, stack, and cause chain, guarding against cyclic causes.
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
      if (PGLITE_INIT_TRAP_RE.test(current.message) || (current.stack != null && PGLITE_INIT_TRAP_RE.test(current.stack))) {
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
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
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
      instance = await recreate();
    }
  }
}
