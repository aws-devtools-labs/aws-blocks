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
} from './wait-live.js';

/** A fake Response wrapping a status + body. */
function res(status: number, body: string): ProbeResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

/** A fetch stub that returns queued responses in order, then repeats the last. */
function seqFetch(responses: ProbeResponse[]): ProbeFetch & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fn: ProbeFetch & { calls: string[] } = Object.assign(
    async (url: string): Promise<ProbeResponse> => {
      calls.push(url);
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    },
    { calls },
  );
  return fn;
}

/** A fetch stub that throws (network error) a given number of times, then serves. */
function throwThenServe(throwCount: number, then: ProbeResponse): ProbeFetch {
  let n = 0;
  return async () => {
    if (n++ < throwCount) throw new Error('ECONNREFUSED');
    return then;
  };
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

const REAL = JSON.stringify({ apiUrl: '/aws-blocks/api', environment: 'production' });
const PLACEHOLDER = JSON.stringify({ _placeholder: true });

describe('classifyConfigBody', () => {
  it('treats a non-placeholder config object as live', () => {
    assert.equal(classifyConfigBody(REAL), 'live');
    // Backend-config-only app whose config carries no apiUrl is still live.
    assert.equal(classifyConfigBody(JSON.stringify({ environment: 'production' })), 'live');
    assert.equal(classifyConfigBody(JSON.stringify({})), 'live');
  });

  it('treats the synth placeholder as pending', () => {
    assert.equal(classifyConfigBody(PLACEHOLDER), 'pending');
    assert.equal(classifyConfigBody(JSON.stringify({ _placeholder: true, extra: 1 })), 'pending');
  });

  it('treats unparseable / non-object bodies as unknown (keep waiting, never false-live)', () => {
    assert.equal(classifyConfigBody('<html>403</html>'), 'unknown');
    assert.equal(classifyConfigBody(''), 'unknown');
    assert.equal(classifyConfigBody('null'), 'unknown');
    assert.equal(classifyConfigBody('"a string"'), 'unknown');
    assert.equal(classifyConfigBody('42'), 'unknown');
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
  it('returns live immediately when the first probe is the real config', async () => {
    const clk = fakeClock();
    const fetch = seqFetch([res(200, REAL)]);
    const r = await waitForLiveBuild({
      hostingUrl: 'https://d.cloudfront.net',
      timeoutMs: 60_000,
      intervalMs: 5_000,
      fetch,
      now: clk.now,
      sleep: clk.sleep,
    });
    assert.equal(r.live, true);
    assert.equal(r.reason, 'live');
    assert.equal(r.attempts, 1);
    assert.equal(fetch.calls.length, 1);
  });

  it('keeps polling while the placeholder is served, then returns live on cutover', async () => {
    const clk = fakeClock();
    const fetch = seqFetch([res(200, PLACEHOLDER), res(200, PLACEHOLDER), res(200, REAL)]);
    const r = await waitForLiveBuild({
      hostingUrl: 'https://d.cloudfront.net',
      timeoutMs: 60_000,
      intervalMs: 5_000,
      fetch,
      now: clk.now,
      sleep: clk.sleep,
    });
    assert.equal(r.live, true);
    assert.equal(r.attempts, 3);
  });

  it('retries through transient network/edge errors (never a false live)', async () => {
    const clk = fakeClock();
    // Two thrown errors, then a 503, then the real config.
    let n = 0;
    const fetch: ProbeFetch = async () => {
      n += 1;
      if (n <= 2) throw new Error('socket hang up');
      if (n === 3) return res(503, 'Service Unavailable');
      return res(200, REAL);
    };
    const r = await waitForLiveBuild({
      hostingUrl: 'https://d.cloudfront.net',
      timeoutMs: 60_000,
      intervalMs: 5_000,
      fetch,
      now: clk.now,
      sleep: clk.sleep,
    });
    assert.equal(r.live, true);
    assert.equal(r.attempts, 4);
  });

  it('times out (live=false) when the placeholder never clears within budget', async () => {
    const clk = fakeClock();
    const fetch = seqFetch([res(200, PLACEHOLDER)]);
    const r = await waitForLiveBuild({
      hostingUrl: 'https://d.cloudfront.net',
      timeoutMs: 20_000,
      intervalMs: 5_000,
      fetch,
      now: clk.now,
      sleep: clk.sleep,
    });
    assert.equal(r.live, false);
    assert.equal(r.reason, 'timeout');
    // With a 20s budget and 5s interval, it polls until the next sleep would
    // cross the deadline: attempts at t=0,5,10,15 → the t=15 check sees
    // 15+5>=20 and stops. 4 attempts.
    assert.equal(r.attempts, 4);
  });

  it('reports each non-live attempt through onAttempt', async () => {
    const clk = fakeClock();
    const fetch = throwThenServe(1, res(200, REAL));
    const seen: string[] = [];
    const r = await waitForLiveBuild({
      hostingUrl: 'https://d.cloudfront.net',
      timeoutMs: 60_000,
      intervalMs: 5_000,
      fetch,
      now: clk.now,
      sleep: clk.sleep,
      onAttempt: ({ result }) => seen.push(result),
    });
    assert.equal(r.live, true);
    assert.deepEqual(seen, ['error', 'live']);
  });
});
