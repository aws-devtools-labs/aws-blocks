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
// `/.blocks-sandbox/config.json`. During synth a PLACEHOLDER (`{_placeholder:
// true}`) is written into the static assets; the real config (carrying
// `apiUrl`) is deployed last, under the new build prefix, and the viewer
// function only routes to the new build once it is live. So a request to
// `/.blocks-sandbox/config.json` through CloudFront that returns a NON-
// placeholder body is proof the new build's function + config are both live at
// the edge — which is exactly the acceptance criterion ("all requests issued
// immediately after the signal return the new asset").
//
// Everything here is pure and dependency-injected (fetch + clock) so the poll
// loop is unit-tested without a real network or real wall-clock sleeps.

/** Public path of the runtime config, relative to the frontend origin. */
export const CONFIG_PROBE_PATH = '/.blocks-sandbox/config.json';

/** A minimal subset of the `fetch` Response we depend on. */
export interface ProbeResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** A minimal `fetch`-like function the poller calls. Injected for tests. */
export type ProbeFetch = (url: string) => Promise<ProbeResponse>;

/**
 * Classify a single fetched config body. Pure and exported so the "is this the
 * new build?" decision is unit-tested against real body shapes.
 *
 * - `live`    — a non-placeholder JSON object (the real deployed config).
 * - `pending` — the synth placeholder (`{_placeholder:true}`) is still served,
 *   i.e. CloudFront has not cut over to the new build yet.
 * - `unknown` — the body is not JSON we recognize (an error page, an empty
 *   body, a truncated response); treated like `pending` so the loop keeps
 *   waiting rather than declaring a false "live".
 */
export function classifyConfigBody(body: string): 'live' | 'pending' | 'unknown' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'unknown';
  }
  if (parsed === null || typeof parsed !== 'object') return 'unknown';
  // The placeholder is exactly `{_placeholder:true}`. Any config without that
  // marker is the real deployed config — we do not require a specific field so
  // this stays correct for backend-config-only apps whose config carries no
  // `apiUrl`. `in` narrows without a cast; the value reads as `unknown`, which
  // `=== true` accepts.
  if ('_placeholder' in parsed && parsed._placeholder === true) return 'pending';
  return 'live';
}

/** Options for {@link waitForLiveBuild}. */
export interface WaitForLiveOptions {
  /** Public frontend origin, e.g. `https://d123.cloudfront.net` (no trailing slash required). */
  hostingUrl: string;
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
  // A unique query string defeats any intermediary/edge cache so each poll
  // reflects the current origin state, not a cached earlier body.
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
  const { hostingUrl, timeoutMs, intervalMs, fetch, now, sleep, onAttempt } = options;
  const start = now();
  let attempt = 0;

  for (;;) {
    attempt += 1;
    let result: 'live' | 'pending' | 'unknown' | 'error' = 'error';
    let detail: string | undefined;
    try {
      const res = await fetch(buildProbeUrl(hostingUrl, now()));
      if (res.ok) {
        result = classifyConfigBody(await res.text());
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
