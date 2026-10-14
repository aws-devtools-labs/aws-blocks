// SPDX-License-Identifier: Apache-2.0

// Post-deploy liveness gate for `npm run deploy --wait-live`.
//
// The problem: `cdk deploy` returning is NOT the same as the new
// build being served. A frontend deploy publishes assets under a per-deploy
// `builds/<buildId>/` prefix and swaps the served build atomically via a
// viewer-request CloudFront function that rewrites every URI to that prefix.
// Both the new function and the real `config.json` have their own edge
// propagation window, so for a short interval after the deploy process exits
// CloudFront can still serve the PREVIOUS build. Emitting `BLOCKS_DEPLOYED`
// then lets a caller's self-test hit the old bundle and silently miss a
// regression (observed in 2/5 benchmark runs).
//
// The observable that proves cutover: the public runtime config at
// `/.blocks-sandbox/config.json`. The deploy stamps THIS deploy's build id into
// that config under `__blocksBuildId` (see `BLOCKS_BUILD_ID_CONFIG_KEY`), and
// surfaces the same id as the `HostingBuildId` CDK output. The poller fetches
// the config through CloudFront and declares the build live only when the
// served config's `__blocksBuildId` equals the id this deploy just published.
//
// Why the id matters: the deployed config body is otherwise deploy-INVARIANT
// (`{...backendConfig, apiUrl}`), so a placeholder-vs-real check only witnesses
// the cutover on the FIRST-ever deploy — when the prior body was the synth
// placeholder. On every re-deploy (the common case) a POP still routing to the
// OLD build serves a byte-identical config, so a non-placeholder check would
// report "live" against stale content: the exact bug this feature targets. The
// per-deploy id turns the question from "SOME real build is live" into "THIS
// build is live", which is correct on re-deploys.
//
// Backward-compat: when the caller cannot supply an expected build id (an older
// app whose stack emits no `HostingBuildId` output), the poller falls back to
// the placeholder-vs-real check — reliable on a first deploy, best-effort on a
// re-deploy — rather than failing. Callers that CAN supply the id get the
// strong guarantee.
//
// Everything here is pure and dependency-injected (fetch + clock) so the poll
// loop is unit-tested without a real network or real wall-clock sleeps.

/** Public path of the runtime config, relative to the frontend origin. */
export const CONFIG_PROBE_PATH = '/.blocks-sandbox/config.json';

/**
 * Key under which the deploy stamps this deploy's build id into the public
 * runtime config. Shared with the CDK hosting construct (which writes it) so
 * the writer and the poller never drift. Double-underscore-prefixed to mark it
 * an internal, non-customer-facing config field.
 */
export const BLOCKS_BUILD_ID_CONFIG_KEY = '__blocksBuildId';

/** A minimal subset of the `fetch` Response we depend on. */
export interface ProbeResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** A minimal `fetch`-like function the poller calls. Injected for tests. */
export type ProbeFetch = (url: string) => Promise<ProbeResponse>;

/**
 * Classify a single fetched config body against the build id this deploy
 * published. Pure and exported so the "is THIS build live?" decision is
 * unit-tested against real body shapes.
 *
 * @param body            the raw config body fetched through CloudFront.
 * @param expectedBuildId the build id this deploy just published (from the
 *   `HostingBuildId` CDK output). When omitted, the function falls back to the
 *   legacy placeholder-vs-real check (see the module header).
 *
 * - `live`    — the served config proves the NEW build is live:
 *     • with an `expectedBuildId`: the config's `__blocksBuildId` equals it;
 *     • without one (legacy): a non-placeholder config object is served.
 * - `pending` — the new build is NOT yet live:
 *     • the synth placeholder (`{_placeholder:true}`) is still served; or
 *     • a real config is served but its `__blocksBuildId` is missing or does
 *       not match the expected id (a POP still routing to the OLD build).
 * - `unknown` — the body is not JSON we recognize (an error page, an empty
 *   body, a truncated response); treated like `pending` so the loop keeps
 *   waiting rather than declaring a false "live".
 */
export function classifyConfigBody(
  body: string,
  expectedBuildId?: string,
): 'live' | 'pending' | 'unknown' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'unknown';
  }
  if (parsed === null || typeof parsed !== 'object') return 'unknown';
  // The placeholder is exactly `{_placeholder:true}` — never the new build.
  if ('_placeholder' in parsed && parsed._placeholder === true) return 'pending';

  // Strong path: match the per-deploy build id. A served config whose
  // `__blocksBuildId` differs from (or lacks) the expected id is a POP still
  // routing to the OLD build — keep waiting rather than report a false live.
  if (expectedBuildId !== undefined) {
    return readStringProp(parsed, BLOCKS_BUILD_ID_CONFIG_KEY) === expectedBuildId
      ? 'live'
      : 'pending';
  }

  // Legacy fallback (no expected id available): any non-placeholder config
  // object counts as live. Reliable on a first deploy; best-effort on a
  // re-deploy (a byte-identical old config can read as live).
  return 'live';
}

/**
 * Read a string-valued property from an object without a type cast. Returns
 * `undefined` when the key is absent or the value is not a string, so a
 * non-string `__blocksBuildId` never accidentally matches an expected id.
 */
function readStringProp(obj: object, key: string): string | undefined {
  if (!(key in obj)) return undefined;
  const record: Record<string, unknown> = { ...obj };
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Options for {@link waitForLiveBuild}. */
export interface WaitForLiveOptions {
  /** Public frontend origin, e.g. `https://d123.cloudfront.net` (no trailing slash required). */
  hostingUrl: string;
  /**
   * The build id this deploy published (from the `HostingBuildId` CDK output).
   * When set, the poll declares live only once the served config's
   * `__blocksBuildId` matches it — correct across re-deploys. When omitted, the
   * poll falls back to the legacy placeholder-vs-real check.
   */
  expectedBuildId?: string;
  /** Overall budget in milliseconds before giving up. */
  timeoutMs: number;
  /** Delay between polls in milliseconds. */
  intervalMs: number;
  /** Injected fetch. */
  fetch: ProbeFetch;
  /** Injected clock: current epoch ms. */
  now: () => number;
  /** Injected sleep: resolve after the given ms. */
  sleep: (ms: number) => Promise<void>;
  /** Optional structured log sink; defaults to a no-op. */
  onAttempt?: (info: { attempt: number; result: 'live' | 'pending' | 'unknown' | 'error'; detail?: string }) => void;
}

/** Outcome of the liveness wait. */
export interface WaitForLiveResult {
  live: boolean;
  attempts: number;
  elapsedMs: number;
  /** Why the wait ended: new build confirmed, budget exhausted. */
  reason: 'live' | 'timeout';
}

/** Build the cache-busting probe URL for the config under a frontend origin. */
export function buildProbeUrl(hostingUrl: string, now: number): string {
  const base = hostingUrl.replace(/\/+$/, '');
  // The primary edge-freshness guarantee is the config's OWN cache-control: it
  // is deployed `max-age=60, must-revalidate` and registered as a no-cache path
  // (hosting.ts), so CloudFront revalidates it against the origin rather than
  // serving a long-lived cached body. The viewer function rewrites this path to
  // `/builds/<id>/.blocks-sandbox/config.json`, and a query string does NOT
  // change that rewritten S3 cache key — so this `_blocks_live` param does not
  // force a fresh ORIGIN fetch at the edge; it only defeats any intermediary /
  // browser cache on the polling client so each poll reflects the latest body
  // the edge returns.
  return `${base}${CONFIG_PROBE_PATH}?_blocks_live=${now}`;
}

/**
 * Poll the deployed frontend's runtime config until it reflects the new build
 * (non-placeholder) or the timeout is reached. Never throws — a fetch error is
 * treated as "not live yet" and retried, because the edge returns transient
 * errors (403/503) during propagation. The caller decides what to do with a
 * `live: false` result (warn + non-zero exit), never emitting a false signal.
 */
export async function waitForLiveBuild(options: WaitForLiveOptions): Promise<WaitForLiveResult> {
  const { hostingUrl, expectedBuildId, timeoutMs, intervalMs, fetch, now, sleep, onAttempt } = options;
  const start = now();
  let attempt = 0;

  for (;;) {
    attempt += 1;
    let result: 'live' | 'pending' | 'unknown' | 'error' = 'error';
    let detail: string | undefined;
    try {
      const res = await fetch(buildProbeUrl(hostingUrl, now()));
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
    onAttempt?.({ attempt, result, detail });

    if (result === 'live') {
      return { live: true, attempts: attempt, elapsedMs: now() - start, reason: 'live' };
    }

    // Out of budget? Report not-live rather than sleeping past the deadline.
    if (now() - start + intervalMs >= timeoutMs) {
      return { live: false, attempts: attempt, elapsedMs: now() - start, reason: 'timeout' };
    }
    await sleep(intervalMs);
  }
}
