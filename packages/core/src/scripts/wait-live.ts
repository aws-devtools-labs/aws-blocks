// SPDX-License-Identifier: Apache-2.0

// Post-deploy liveness gate for `npm run deploy --wait-live`.
//
// `cdk deploy` returning is not the same as the new build being served:
// CloudFront takes a short window to propagate the new per-build viewer
// function and config, so a caller's immediate self-test can hit the previous
// bundle and miss a regression. This polls the public runtime config until the
// new build is confirmed live, matching THIS deploy's build id (stamped under
// `__blocksBuildId`, surfaced as the `HostingBuildId` CDK output). The id is
// what makes a re-deploy correct: the rest of the config body is
// deploy-invariant, so without it an old and new config are byte-identical at
// the edge. When no id is available (an older stack), the poller falls back to
// a placeholder-vs-real check — reliable on a first deploy, best-effort on a
// re-deploy. Pure and dependency-injected (fetch + clock) for unit testing.

/** Public path of the runtime config, relative to the frontend origin. */
export const CONFIG_PROBE_PATH = '/.blocks-sandbox/config.json';

/**
 * Config key the deploy stamps this build's id under. Shared with the CDK
 * hosting construct (the writer) so writer and poller never drift.
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
 * published. Pure and exported so the decision is unit-tested directly.
 *
 * With an `expectedBuildId`, `live` means the served config's `__blocksBuildId`
 * matches it; without one (legacy), `live` means any non-placeholder config.
 * `pending` is the synth placeholder or a mismatched/absent id (a POP still on
 * the old build). `unknown` is a body we can't parse, treated like `pending`.
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
  if ('_placeholder' in parsed && parsed._placeholder === true) return 'pending';

  if (expectedBuildId !== undefined) {
    return readStringProp(parsed, BLOCKS_BUILD_ID_CONFIG_KEY) === expectedBuildId
      ? 'live'
      : 'pending';
  }
  return 'live';
}

/** Read a string-valued property from an object without a type cast. */
function readStringProp(obj: object, key: string): string | undefined {
  if (!(key in obj)) return undefined;
  const record: Record<string, unknown> = { ...obj };
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Options for {@link waitForLiveBuild}. */
export interface WaitForLiveOptions {
  /** Public frontend origin, e.g. `https://d123.cloudfront.net`. */
  hostingUrl: string;
  /**
   * Build id this deploy published (the `HostingBuildId` CDK output). When set,
   * the poll declares live only once the served config's `__blocksBuildId`
   * matches it; when omitted, it falls back to the placeholder-vs-real check.
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
 * Poll the deployed frontend's runtime config until it reflects the new build
 * or the timeout is reached. Never throws — a fetch error (the edge returns
 * transient 403/503 during propagation) is treated as "not live yet" and
 * retried. The caller decides what to do with a `live: false` result.
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
