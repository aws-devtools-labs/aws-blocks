// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  classifyConfigBody,
  buildProbeUrl,
  waitForLiveBuild,
  CONFIG_PROBE_PATH,
  type ProbeResponse,
  type ProbeFetch,
  type InvalidationProbe,
} from './wait-live.js';

/** A fake Response wrapping a status + body. */
function res(status: number, body: string): ProbeResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

/** A fetch stub that returns queued responses in order, then repeats the last. */
function seqFetch(responses: ProbeResponse[]): ProbeFetch & { calls: string[]; timeouts: number[] } {
  const calls: string[] = [];
  const timeouts: number[] = [];
  let i = 0;
  const fn = async (url: string, timeoutMs: number): Promise<ProbeResponse> => {
    calls.push(url);
    timeouts.push(timeoutMs);
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  };
  return Object.assign(fn, { calls, timeouts });
}

/** A deterministic clock + sleep that advances virtual time on each sleep. */
function fakeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const BUILD_ID = 'mg7k2p-ab12cd34';
const REAL = JSON.stringify({ apiUrl: '/aws-blocks/api', environment: 'production' });
const REAL_WITH_ID = JSON.stringify({
  apiUrl: '/aws-blocks/api',
  environment: 'production',
  __blocksBuildId: BUILD_ID,
});
const REAL_WITH_OLD_ID = JSON.stringify({
  apiUrl: '/aws-blocks/api',
  environment: 'production',
  __blocksBuildId: 'OLD-9z9z9z-00000000',
});
const PLACEHOLDER = JSON.stringify({ _placeholder: true });

describe('classifyConfigBody', () => {
  it('is live only when the served config carries the matching build id', () => {
    assert.equal(classifyConfigBody(REAL_WITH_ID, BUILD_ID), 'live');
  });

  it('is pending when the served config carries a DIFFERENT build id (stale POP)', () => {
    // The exact re-deploy scenario this feature targets: a byte-plausible real
    // config from the OLD build is served during cutover — must NOT read live.
    assert.equal(classifyConfigBody(REAL_WITH_OLD_ID, BUILD_ID), 'pending');
  });

  it('is pending when the served config has no build id at all', () => {
    assert.equal(classifyConfigBody(REAL, BUILD_ID), 'pending');
    assert.equal(classifyConfigBody(JSON.stringify({}), BUILD_ID), 'pending');
  });

  it('is pending when the build id is present but not a string', () => {
    assert.equal(classifyConfigBody(JSON.stringify({ __blocksBuildId: 123 }), BUILD_ID), 'pending');
  });

  it('is pending for the synth placeholder', () => {
    assert.equal(classifyConfigBody(PLACEHOLDER, BUILD_ID), 'pending');
  });

  it('treats unparseable / non-object bodies as unknown (keep waiting, never false-live)', () => {
    assert.equal(classifyConfigBody('<html>403</html>', BUILD_ID), 'unknown');
    assert.equal(classifyConfigBody('', BUILD_ID), 'unknown');
    assert.equal(classifyConfigBody('null', BUILD_ID), 'unknown');
    assert.equal(classifyConfigBody('"a string"', BUILD_ID), 'unknown');
    assert.equal(classifyConfigBody('42', BUILD_ID), 'unknown');
  });
});

describe('buildProbeUrl', () => {
  it('appends the config path and a cache-busting query', () => {
    const u = buildProbeUrl('https://d123.cloudfront.net', 1700);
    assert.ok(u.startsWith(`https://d123.cloudfront.net${CONFIG_PROBE_PATH}?`));
    assert.ok(u.includes('_blocks_live=1700'));
  });

  it('strips a trailing slash on the origin so the path is not doubled', () => {
    const u = buildProbeUrl('https://d123.cloudfront.net/', 1);
    assert.ok(u.startsWith(`https://d123.cloudfront.net${CONFIG_PROBE_PATH}?`));
    assert.ok(!u.includes('.net//'));
  });
});

describe('waitForLiveBuild', () => {
  const base = {
    hostingUrl: 'https://d.cloudfront.net',
    expectedBuildId: BUILD_ID,
    timeoutMs: 60_000,
    intervalMs: 2_000,
  };

  it('returns live immediately when the first probe carries the matching build id', async () => {
    const clk = fakeClock();
    const fetch = seqFetch([res(200, REAL_WITH_ID)]);
    const r = await waitForLiveBuild({ ...base, fetch, now: clk.now, sleep: clk.sleep });
    assert.equal(r.live, true);
    assert.equal(r.reason, 'live');
    assert.equal(r.attempts, 1);
    assert.equal(fetch.calls.length, 1);
  });

  it('passes a per-request timeout to fetch, capped by the remaining budget', async () => {
    const clk = fakeClock();
    const fetch = seqFetch([res(200, REAL_WITH_ID)]);
    await waitForLiveBuild({ ...base, fetch, now: clk.now, sleep: clk.sleep });
    // First probe: min(10s cap, 60s remaining) = 10s.
    assert.equal(fetch.timeouts[0], 10_000);
  });

  it('caps the per-request timeout at the remaining budget when under 10s', async () => {
    const clk = fakeClock();
    // 5s overall budget: the first probe's per-request timeout is capped to the
    // 5s remaining, not the full 10s — so a stalled request can't run past the
    // deploy's own budget. Serve a pending config so the loop reaches the probe.
    const fetch = seqFetch([res(200, PLACEHOLDER)]);
    await waitForLiveBuild({ ...base, timeoutMs: 5_000, fetch, now: clk.now, sleep: clk.sleep });
    assert.equal(fetch.timeouts[0], 5_000);
    assert.ok(fetch.timeouts.every((t) => t >= 1 && t <= 5_000), 'every probe timeout is within the 5s budget');
  });

  it('waits through a stale OLD-build config and goes live only on the matching id', async () => {
    const clk = fakeClock();
    const fetch = seqFetch([res(200, REAL_WITH_OLD_ID), res(200, REAL_WITH_OLD_ID), res(200, REAL_WITH_ID)]);
    const r = await waitForLiveBuild({ ...base, fetch, now: clk.now, sleep: clk.sleep });
    assert.equal(r.live, true);
    assert.equal(r.attempts, 3);
  });

  it('times out if only the OLD-build config is ever served', async () => {
    const clk = fakeClock();
    const fetch = seqFetch([res(200, REAL_WITH_OLD_ID)]);
    const r = await waitForLiveBuild({ ...base, timeoutMs: 10_000, fetch, now: clk.now, sleep: clk.sleep });
    assert.equal(r.live, false);
    assert.equal(r.reason, 'timeout');
  });

  it('retries through transient network/edge errors (never a false live)', async () => {
    const clk = fakeClock();
    let n = 0;
    const fetch: ProbeFetch = async () => {
      n += 1;
      if (n <= 2) throw new Error('socket hang up');
      if (n === 3) return res(503, 'Service Unavailable');
      return res(200, REAL_WITH_ID);
    };
    const r = await waitForLiveBuild({ ...base, fetch, now: clk.now, sleep: clk.sleep });
    assert.equal(r.live, true);
    assert.equal(r.attempts, 4);
  });

  it('probes once at the deadline rather than giving up an interval early', async () => {
    const clk = fakeClock();
    const fetch = seqFetch([res(200, PLACEHOLDER)]);
    const r = await waitForLiveBuild({ ...base, timeoutMs: 10_000, fetch, now: clk.now, sleep: clk.sleep });
    assert.equal(r.live, false);
    assert.equal(r.reason, 'timeout');
    // 2s interval, 10s budget: probes at t=0,2,4,6,8,10 → the t=10 probe fires
    // (loop checks `>= timeoutMs` AFTER the probe), so 6 attempts.
    assert.equal(r.attempts, 6);
  });

  it('reports each non-live attempt through onAttempt', async () => {
    const clk = fakeClock();
    let n = 0;
    const fetch: ProbeFetch = async () => {
      n += 1;
      if (n === 1) throw new Error('ECONNREFUSED');
      return res(200, REAL_WITH_ID);
    };
    const seen: string[] = [];
    const r = await waitForLiveBuild({
      ...base,
      fetch,
      now: clk.now,
      sleep: clk.sleep,
      onAttempt: ({ result }) => { seen.push(result); },
    });
    assert.equal(r.live, true);
    assert.deepEqual(seen, ['error', 'live']);
  });

  describe('with a compute deploy (invalidation probe)', () => {
    it('is not live until BOTH the config matches AND the invalidation completes', async () => {
      const clk = fakeClock();
      const fetch = seqFetch([res(200, REAL_WITH_ID)]); // config live from the start
      let invCalls = 0;
      const invalidationComplete: InvalidationProbe = async () => {
        invCalls += 1;
        return invCalls >= 3 ? 'completed' : 'pending'; // completes on the third check
      };
      const r = await waitForLiveBuild({
        ...base,
        invalidationComplete,
        fetch,
        now: clk.now,
        sleep: clk.sleep,
      });
      assert.equal(r.live, true);
      // Config was live immediately, so the gate is the invalidation: 3 attempts.
      assert.equal(r.attempts, 3);
      assert.equal(invCalls, 3);
    });

    it('does not probe the invalidation until the config matches', async () => {
      const clk = fakeClock();
      const fetch = seqFetch([res(200, REAL_WITH_OLD_ID), res(200, REAL_WITH_ID)]);
      let invCalls = 0;
      const invalidationComplete: InvalidationProbe = async () => {
        invCalls += 1;
        return 'completed';
      };
      await waitForLiveBuild({ ...base, invalidationComplete, fetch, now: clk.now, sleep: clk.sleep });
      // Attempt 1 config is stale → no invalidation probe; attempt 2 config
      // matches → one invalidation probe, which completes.
      assert.equal(invCalls, 1);
    });

    it('treats a pending invalidation (transient) as not-live-yet and retries', async () => {
      const clk = fakeClock();
      const fetch = seqFetch([res(200, REAL_WITH_ID)]);
      let invCalls = 0;
      const invalidationComplete: InvalidationProbe = async () => {
        invCalls += 1;
        return invCalls === 1 ? 'pending' : 'completed';
      };
      const r = await waitForLiveBuild({ ...base, invalidationComplete, fetch, now: clk.now, sleep: clk.sleep });
      assert.equal(r.live, true);
      assert.equal(r.attempts, 2);
    });

    it('stops immediately on a TERMINAL invalidation error (never burns the budget)', async () => {
      const clk = fakeClock();
      const fetch = seqFetch([res(200, REAL_WITH_ID)]); // config live from the start
      let invCalls = 0;
      const invalidationComplete: InvalidationProbe = async () => {
        invCalls += 1;
        return { fatal: 'AccessDenied' };
      };
      const r = await waitForLiveBuild({ ...base, invalidationComplete, fetch, now: clk.now, sleep: clk.sleep });
      assert.equal(r.live, false);
      assert.equal(r.reason, 'fatal');
      assert.equal(r.fatal, 'AccessDenied');
      // Stopped on the first terminal result rather than retrying to timeout.
      assert.equal(invCalls, 1);
      assert.equal(r.attempts, 1);
    });

    it('stops re-probing the invalidation once it has completed', async () => {
      const clk = fakeClock();
      // Config stays live; invalidation completes on attempt 1. If the config
      // somehow flapped we would still not re-probe a completed invalidation.
      const fetch = seqFetch([res(200, REAL_WITH_ID)]);
      let invCalls = 0;
      const invalidationComplete: InvalidationProbe = async () => {
        invCalls += 1;
        return 'completed';
      };
      const r = await waitForLiveBuild({ ...base, invalidationComplete, fetch, now: clk.now, sleep: clk.sleep });
      assert.equal(r.live, true);
      assert.equal(invCalls, 1);
    });
  });
});
