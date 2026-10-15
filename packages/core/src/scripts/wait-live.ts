// SPDX-License-Identifier: Apache-2.0

// Post-deploy liveness gate for `npm run deploy --wait-live`.
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
 * Probe one CloudFront invalidation's status. Returns `true` once it has
 * reached `Completed`. Injected so the SDK call lives in the deploy script and
 * this module stays pure.
 */
export type InvalidationProbe = (timeoutMs: number) => Promise<boolean>;

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
  /** Why the wait ended: new build confirmed, or budget exhausted. */
  reason: 'live' | 'timeout';
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
 * deploy, the `/*` invalidation reaching `Completed`. Never throws — a fetch or
 * invalidation error (the edge returns transient 403/503 during propagation) is
 * treated as "not live yet" and retried. The caller decides what to do with a
 * `live: false` result.
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
    const requestTimeout = Math.min(PROBE_REQUEST_TIMEOUT_MS, remaining || PROBE_REQUEST_TIMEOUT_MS);
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
    // live, else the edge may still serve the previous build's SSR HTML.
    if (result === 'live' && !invalidationDone && invalidationComplete) {
      try {
        invalidationDone = await invalidationComplete(requestTimeout);
      } catch (e) {
        invalidationDone = false;
        detail = `invalidation: ${e instanceof Error ? e.message : String(e)}`;
      }
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
