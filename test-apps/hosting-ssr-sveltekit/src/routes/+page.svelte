<script lang="ts">
  import { base } from '$app/paths';

  type Status = 'idle' | 'pending' | 'pass' | 'fail';
  type Probe = {
    id: string;
    label: string;
    run: () => Promise<{ pass: boolean; observed: unknown }>;
  };

  const probes: Probe[] = [
    {
      id: 'ssr',
      label: 'SSR page renders server data',
      run: async () => {
        const r = await fetch(`${base}/ssr`);
        const t = await r.text();
        return { pass: r.ok && t.includes('ssr-marker'), observed: r.status };
      },
    },
    {
      id: 'api-get',
      label: '+server.js GET returns JSON',
      run: async () => {
        const r = await fetch(`${base}/api/echo`);
        const j = await r.json();
        return { pass: r.ok && j.method === 'GET', observed: j };
      },
    },
    {
      id: 'api-post',
      label: '+server.js POST echoes body',
      run: async () => {
        const r = await fetch(`${base}/api/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ping: 'pong' }),
        });
        const j = await r.json();
        return { pass: r.ok && j.body?.ping === 'pong', observed: j };
      },
    },
    {
      id: 'prerender',
      label: 'Prerendered /about is reachable',
      run: async () => {
        const r = await fetch(`${base}/about`);
        const t = await r.text();
        return { pass: r.ok && t.includes('about-marker'), observed: r.status };
      },
    },
    {
      id: 'headers',
      label: 'Custom header on /api/echo',
      run: async () => {
        const r = await fetch(`${base}/api/echo`);
        return {
          pass: r.headers.get('x-sk-endpoint') === 'echo',
          observed: r.headers.get('x-sk-endpoint'),
        };
      },
    },
    {
      id: 'cookies',
      label: 'Server sets sk_visit cookie',
      run: async () => {
        const r = await fetch(`${base}/api/whoami`, { credentials: 'include' });
        const j = await r.json();
        return { pass: r.ok && typeof j.visit === 'string', observed: j };
      },
    },
  ];

  let statuses = $state<Record<string, Status>>(
    Object.fromEntries(probes.map((p) => [p.id, 'idle'])),
  );
  let observed = $state<Record<string, unknown>>({});

  async function runAll() {
    for (const p of probes) statuses[p.id] = 'pending';
    await Promise.all(
      probes.map(async (p) => {
        try {
          const res = await p.run();
          observed[p.id] = res.observed;
          statuses[p.id] = res.pass ? 'pass' : 'fail';
        } catch (e) {
          observed[p.id] = String(e);
          statuses[p.id] = 'fail';
        }
      }),
    );
  }

  let summary = $derived(
    (() => {
      const vals = Object.values(statuses);
      const pass = vals.filter((s) => s === 'pass').length;
      const fail = vals.filter((s) => s === 'fail').length;
      return `${pass} pass / ${fail} fail / ${vals.length} total`;
    })(),
  );

  function color(s: Status) {
    return s === 'pass' ? '#1a7f37' : s === 'fail' ? '#cf222e' : '#9a6700';
  }
</script>

<main>
  <h2 data-testid="page-id" data-page="home">Feature Dashboard</h2>
  <p data-testid="ssr-home-marker">Server-rendered SvelteKit home.</p>

  <button
    data-testid="run-probes"
    onclick={runAll}
    style="background: #24292f; color: #fff; border: 0; padding: 8px 16px; border-radius: 6px; cursor: pointer;"
  >
    Run probes
  </button>
  <p data-testid="probe-summary" style="font-weight: 600;">{summary}</p>

  <ul style="list-style: none; padding: 0;">
    {#each probes as p (p.id)}
      <li
        data-testid={`probe-${p.id}`}
        style="border: 1px solid #d0d7de; border-radius: 8px; padding: 10px 14px; margin: 8px 0;"
      >
        <div style="display: flex; gap: 8px; align-items: center;">
          <strong>{p.label}</strong>
          <span
            data-testid={`probe-status-${p.id}`}
            data-status={statuses[p.id]}
            style="margin-left: auto; color: {color(statuses[p.id])}; font-weight: 700; text-transform: uppercase; font-size: 12px;"
          >
            {statuses[p.id]}
          </span>
        </div>
        {#if observed[p.id] != null}
          <pre style="background: #0d1117; color: #c9d1d9; padding: 8px; border-radius: 6px; font-size: 12px; overflow-x: auto; margin: 6px 0 0;">{JSON.stringify(observed[p.id], null, 2)}</pre>
        {/if}
      </li>
    {/each}
  </ul>
</main>
