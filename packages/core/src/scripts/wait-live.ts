// SPDX-License-Identifier: Apache-2.0

// Post-deploy liveness gate for `npm run deploy -- --wait-live`.
//
// `cdk deploy` returning is not the same as the new build being served. Two
// edge windows stay open after CloudFormation reports complete:
//   1. The per-build viewer function + runtime config propagate across POPs
//      (the KVS cutover). Proven by polling the public config until its
//      `__blocksBuildId` matches THIS deploy's build id.
//   2. For a compute/SSR deploy, the `/*` CloudFront invalidation that flushes
//      the previous build's edge-cached SSR HTML is fire-and-forget
//      (cdn_construct.ts) — CloudFormation returns before it finishes, so the
//      edge can still serve old HTML referencing old hashed assets (→ 403).
//      Proven by polling `GetInvalidation` until `Completed`.
//
// A deploy is live only when BOTH hold. Both probes are dependency-injected
// (fetch + an invalidation-status probe + clock) so the loop is unit-tested
// with no network and no real sleeps. A pure-static deploy issues no
// invalidation, so the caller omits the invalidation probe and only the config
// check runs.

import { BLOCKS_BUILD_ID_CONFIG_KEY } from '../common/constants.js';
import { BLOCKS_SANDBOX_DIR } from '../common/constants.js';

/** Public path of the runtime config, relative to the frontend origin. */
export const CONFIG_PROBE_PATH = `/${BLOCKS_SANDBOX_DIR}/config.json`;

export { BLOCKS_BUILD_ID_CONFIG_KEY };

/** A minimal subset of the `fetch` Response we depend on. */
export interface ProbeResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/**
 * A minimal `fetch`-like function the poller calls. `timeoutMs` is the
 * per-request budget the caller must enforce (e.g. via `AbortSignal.timeout`)
 * so one stalled response cannot hold the deploy past its overall budget.
 */
export type ProbeFetch = (url: string, timeoutMs: number) => Promise<ProbeResponse>;

/**
 * Probe one CloudFront invalidation's status. Resolves to:
 *   - `'completed'` once it has reached `Completed`;
 *   - `'pending'` while still in progress (retry);
 *   - `{ fatal: <reason> }` for an error that can never clear during this
 *     deploy (missing Region, `AccessDenied`, `NoSuchInvalidation`, …), so the
 *     loop stops instead of burning the whole budget on a doomed retry.
 * Injected so the SDK call lives in the deploy script and this module stays
 * pure. A transient error (throttling, 5xx) should resolve `'pending'`.
 */
export type InvalidationProbe = (timeoutMs: number) => Promise<InvalidationProbeResult>;

/** Outcome of a single invalidation-status probe. */
export type InvalidationProbeResult = 'completed' | 'pending' | { fatal: string };

/**
 * Classify a fetched config body against the build id this deploy published.
 * `live` means the served config's `__blocksBuildId` equals `expectedBuildId`;
 * `pending` is the synth placeholder or a mismatched/absent id (a POP still on
 * the old build); `unknown` is a body we can't parse (treated like `pending`).
 */
export function classifyConfigBody(
  body: string,
  expectedBuildId: string,
): 'live' | 'pending' | 'unknown' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'unknown';
  }
  if (parsed === null || typeof parsed !== 'object') return 'unknown';
  if ('_placeholder' in parsed && parsed._placeholder === true) return 'pending';
  return readStringProp(parsed, BLOCKS_BUILD_ID_CONFIG_KEY) === expectedBuildId
    ? 'live'
    : 'pending';
}

/** Read a string-valued property from an object without a type cast. */
function readStringProp(obj: object, key: string): string | undefined {
  if (!(key in obj)) return undefined;
  const record: Record<string, unknown> = { ...obj };
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Per-request timeout for a single config probe (ms), capped by remaining budget. */
export const PROBE_REQUEST_TIMEOUT_MS = 10_000;

/** Options for {@link waitForLiveBuild}. */
export interface WaitForLiveOptions {
  /** Public frontend origin, e.g. `https://d123.cloudfront.net`. */
  hostingUrl: string;
  /** Build id this deploy published (the `HostingBuildId` CDK output). */
  expectedBuildId: string;
  /**
   * Probe the `/*` invalidation's status, for a compute deploy. Omitted for a
   * pure-static deploy (no invalidation), where only the config check gates.
   */
  invalidationComplete?: InvalidationProbe;
  /** Overall budget in milliseconds before giving up. */
  timeoutMs: number;
  /** Delay between polls in milliseconds. */
  intervalMs: number;
  /** Injected fetch (per-request timeout enforced by the caller). */
  fetch: ProbeFetch;
  /** Injected clock: current epoch ms. */
  now: () => number;
  /** Injected sleep: resolve after the given ms. */
  sleep: (ms: number) => Promise<void>;
  /** Optional structured log sink; defaults to a no-op. */
  onAttempt?: (info: {
    attempt: number;
    result: 'live' | 'pending' | 'unknown' | 'error';
    detail?: string;
  }) => void;
}

/** Outcome of the liveness wait. */
export interface WaitForLiveResult {
  live: boolean;
  attempts: number;
  elapsedMs: number;
  /** Why the wait ended: new build confirmed, budget exhausted, or a terminal error. */
  reason: 'live' | 'timeout' | 'fatal';
  /** Set when `reason` is `'fatal'`: the error that can never clear this deploy. */
  fatal?: string;
}

/**
 * Build the cache-busting probe URL for the config under a frontend origin.
 *
 * The edge-freshness guarantee is the config's own cache-control (deployed
 * `max-age=60, must-revalidate` and registered as a no-cache path in
 * hosting.ts). The query param does not change the rewritten S3 cache key, so
 * it only defeats intermediary/browser caches on the polling client.
 */
export function buildProbeUrl(hostingUrl: string, now: number): string {
  const base = hostingUrl.replace(/\/+$/, '');
  return `${base}${CONFIG_PROBE_PATH}?_blocks_live=${now}`;
}

/**
 * Poll until the new build is live or the budget is exhausted. Live requires
 * BOTH the served config matching this deploy's build id AND, for a compute
 * deploy, the `/*` invalidation reaching `Completed`. Never throws. A fetch
 * error (the edge returns transient 403/503 during propagation) is treated as
 * "not live yet" and retried. The invalidation probe may instead report a
 * TERMINAL failure (`{ fatal }`) — an error that can never clear this deploy
 * (missing Region, `AccessDenied`, `NoSuchInvalidation`); the loop then stops
 * early and returns `{ live: false, reason: 'fatal', fatal }` so the caller can
 * print the real cause rather than burning the whole budget. The caller decides
 * what to do with a `live: false` result.
 */
export async function waitForLiveBuild(options: WaitForLiveOptions): Promise<WaitForLiveResult> {
  const {
    hostingUrl,
    expectedBuildId,
    invalidationComplete,
    timeoutMs,
    intervalMs,
    fetch,
    now,
    sleep,
    onAttempt,
  } = options;
  const start = now();
  let attempt = 0;
  // Once the invalidation reports Completed it stays completed, so remember it
  // and stop re-probing it on later attempts.
  let invalidationDone = invalidationComplete === undefined;

  for (;;) {
    attempt += 1;
    const remaining = Math.max(0, timeoutMs - (now() - start));
    // Cap the per-request budget by what's left, with a 1ms floor so the
    // deadline probe (remaining 0) still carries a positive timeout instead of
    // the full 10s — which would let the last probe (and the invalidation probe
    // that reuses it) run ~20s past the overall budget.
    const requestTimeout = Math.max(1, Math.min(PROBE_REQUEST_TIMEOUT_MS, remaining));
    let result: 'live' | 'pending' | 'unknown' | 'error' = 'error';
    let detail: string | undefined;
    try {
      const res = await fetch(buildProbeUrl(hostingUrl, now()), requestTimeout);
      if (res.ok) {
        result = classifyConfigBody(await res.text(), expectedBuildId);
      } else {
        result = 'error';
        detail = `HTTP ${res.status}`;
      }
    } catch (e) {
      result = 'error';
      detail = e instanceof Error ? e.message : String(e);
    }

    // Config says this POP serves the new build; now confirm the compute
    // deploy's invalidation has propagated before declaring the whole deploy
    // live, else the edge may still serve the previous build's SSR HTML. A
    // terminal invalidation error stops the loop immediately.
    if (result === 'live' && !invalidationDone && invalidationComplete) {
      let probe: InvalidationProbeResult;
      try {
        probe = await invalidationComplete(requestTimeout);
      } catch (e) {
        // An unexpected throw is treated as transient (retry) — the caller's
        // probe is expected to classify terminal errors as `{ fatal }`.
        probe = 'pending';
        detail = `invalidation: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (typeof probe === 'object') {
        onAttempt?.({ attempt, result: 'error', detail: `invalidation: ${probe.fatal}` });
        return { live: false, attempts: attempt, elapsedMs: now() - start, reason: 'fatal', fatal: probe.fatal };
      }
      invalidationDone = probe === 'completed';
      if (!invalidationDone) result = 'pending';
    }

    onAttempt?.({ attempt, result, detail });

    if (result === 'live') {
      return { live: true, attempts: attempt, elapsedMs: now() - start, reason: 'live' };
    }
    // Out of budget: probe once more at the deadline rather than giving up a
    // whole interval early, then report not-live.
    if (now() - start >= timeoutMs) {
      return { live: false, attempts: attempt, elapsedMs: now() - start, reason: 'timeout' };
    }
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (now() - start))));
  }
}
