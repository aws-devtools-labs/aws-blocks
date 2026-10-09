<script setup lang="ts">
import { api, authApi } from 'hosting-ssr-nuxt-aws-blocks';
import { ref, onMounted } from 'vue';
import ProbeCard from '../components/ProbeCard.vue';

const config = ref<unknown>(null);

onMounted(async () => {
  try {
    const r = await fetch('/.blocks-sandbox/config.json');
    config.value = await r.json();
  } catch {
    config.value = { error: 'config.json not reachable' };
  }
});

const probeCookies = {
  feature: 'GET /api/probe/cookies',
  description: 'Returns 3 Set-Cookie headers (stress-a, stress-b, stress-c). Verifies CloudFront/APIGW does not collapse multiple Set-Cookie headers.',
  source: 'server/api/probe/cookies.get.ts',
  buttons: [
    {
      label: 'GET',
      run: async () => {
        const r = await fetch('/api/probe/cookies');
        const headers: Record<string, string> = {};
        r.headers.forEach((v, k) => { headers[k] = v; });
        const body = await r.text();
        return { pass: r.status === 200, observed: { status: r.status, headers, body: body.slice(0, 500) } };
      },
    },
  ],
};

const probeEcho = {
  feature: 'POST/PUT/DELETE /api/probe/echo',
  description: 'Echo route returns method + body + query. Verifies non-GET methods reach the Nitro SSR Lambda intact.',
  source: 'server/api/probe/echo.{post,put,delete}.ts',
  buttons: [
    {
      label: 'POST { hello: "world" }',
      run: async () => {
        const r = await fetch('/api/probe/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: 'world' }) });
        const body = await r.json();
        return { pass: r.status === 200 && body?.method === 'POST' && body?.body?.hello === 'world', observed: { status: r.status, body } };
      },
    },
    {
      label: 'PUT { updated: true }',
      run: async () => {
        const r = await fetch('/api/probe/echo', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ updated: true }) });
        const body = await r.json();
        return { pass: r.status === 200 && body?.method === 'PUT', observed: { status: r.status, body } };
      },
    },
    {
      label: 'DELETE ?id=42',
      run: async () => {
        const r = await fetch('/api/probe/echo?id=42', { method: 'DELETE' });
        const body = await r.json();
        return { pass: r.status === 200 && body?.method === 'DELETE' && body?.query?.id === '42', observed: { status: r.status, body } };
      },
    },
  ],
};

const probeUpload = {
  feature: 'POST /api/probe/upload',
  description: 'Send 1 MB random binary. Server returns sha256 + byte count. Verifies binary body integrity through CloudFront → APIGW → Lambda.',
  source: 'server/api/probe/upload.post.ts',
  buttons: [
    {
      label: 'POST 256 KB',
      run: async () => {
        const buf = new Uint8Array(256 * 1024);
        crypto.getRandomValues(buf);
        const r = await fetch('/api/probe/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf });
        const body = await r.json();
        return { pass: r.status === 200 && body?.bytes === buf.length, observed: { status: r.status, body } };
      },
    },
    {
      label: 'POST 1 MB',
      run: async () => {
        const buf = new Uint8Array(1024 * 1024);
        const C = 65536;
        for (let i = 0; i < buf.length; i += C) crypto.getRandomValues(buf.subarray(i, Math.min(i + C, buf.length)));
        const t0 = performance.now();
        const r = await fetch('/api/probe/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf });
        const body = await r.json();
        return { pass: r.status === 200 && body?.bytes === buf.length, observed: { status: r.status, ms: Math.round(performance.now() - t0), body } };
      },
    },
  ],
};

const probeStream = {
  feature: 'GET /api/probe/stream',
  description: 'Streams 5 SSE chunks at 200 ms intervals. Verifies streaming end-to-end (RESPONSE_STREAM mode).',
  source: 'server/api/probe/stream.get.ts',
  buttons: [
    {
      label: 'GET (stream)',
      run: async () => {
        const t0 = performance.now();
        const r = await fetch('/api/probe/stream');
        if (!r.body) return { pass: false, observed: { error: 'no body' } };
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        const chunks: { ms: number; text: string }[] = [];
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push({ ms: Math.round(performance.now() - t0), text: dec.decode(value) });
        }
        const ttfb = chunks[0]?.ms ?? -1;
        const total = chunks[chunks.length - 1]?.ms ?? -1;
        const streamed = total - ttfb > 300;
        return { pass: r.status === 200 && chunks.length >= 2 && streamed, observed: { status: r.status, chunkCount: chunks.length, ttfbMs: ttfb, totalMs: total, chunks } };
      },
    },
  ],
};

const probeHealth = {
  feature: 'GET /api/probe/health',
  description: 'Trivial 200 to confirm the SSR Lambda is reachable through CloudFront.',
  source: 'server/api/probe/health.get.ts',
  buttons: [
    {
      label: 'GET',
      run: async () => {
        const r = await fetch('/api/probe/health');
        const body = await r.json().catch(() => null);
        return { pass: r.status === 200 && body?.ok === true, observed: { status: r.status, body } };
      },
    },
  ],
};

const probeThrow = {
  feature: 'GET /api/probe/throw',
  description: 'Always returns 500. Verifies error responses propagate through CloudFront and APIGW intact.',
  source: 'server/api/probe/throw.get.ts',
  buttons: [
    {
      label: 'GET (expect 500)',
      run: async () => {
        const r = await fetch('/api/probe/throw');
        const body = await r.json().catch(() => null);
        return { pass: r.status === 500, observed: { status: r.status, body } };
      },
    },
  ],
};

const probeSlow = {
  feature: 'GET /api/probe/slow?ms=...',
  description: 'Sleeps then responds. APIGW REST has a 29s integration timeout. Use to verify timeout behaviour.',
  source: 'server/api/probe/slow.get.ts',
  buttons: [
    {
      label: 'GET ms=2000',
      run: async () => {
        const t0 = performance.now();
        const r = await fetch('/api/probe/slow?ms=2000');
        const body = await r.json().catch(() => null);
        return { pass: r.status === 200 && body?.slept === 2000, observed: { status: r.status, ms: Math.round(performance.now() - t0), body } };
      },
    },
    {
      label: 'GET ms=25000 (near limit)',
      run: async () => {
        const t0 = performance.now();
        const r = await fetch('/api/probe/slow?ms=25000');
        const body = await r.json().catch(() => null);
        return { pass: r.status === 200 && body?.slept === 25000, observed: { status: r.status, ms: Math.round(performance.now() - t0), body } };
      },
    },
  ],
};

const probeCatchall = {
  feature: 'GET /api/probe/catchall/*',
  description: 'Dynamic catch-all route. Verifies multi-segment paths reach the SSR Lambda.',
  source: 'server/api/probe/catchall/[...slug].get.ts',
  buttons: [
    {
      label: 'GET /a/b/c',
      run: async () => {
        const r = await fetch('/api/probe/catchall/a/b/c');
        const body = await r.json().catch(() => null);
        return { pass: r.status === 200 && Array.isArray(body?.path) && body.path.join('/') === 'a/b/c', observed: { status: r.status, body } };
      },
    },
  ],
};

const probeCounter = {
  feature: 'GET/POST/DELETE /api/probe/counter',
  description: 'Server-side counter (in-memory per Lambda instance). GET reads, POST increments, DELETE resets.',
  source: 'server/api/probe/counter.{get,post,delete}.ts',
  buttons: [
    {
      label: 'GET (read)',
      run: async () => {
        const r = await fetch('/api/probe/counter');
        const body = await r.json().catch(() => null);
        return { pass: r.status === 200 && typeof body?.value === 'number', observed: { status: r.status, body } };
      },
    },
    {
      label: 'POST (+1)',
      run: async () => {
        const r = await fetch('/api/probe/counter', { method: 'POST' });
        const body = await r.json().catch(() => null);
        return { pass: r.status === 200, observed: { status: r.status, body } };
      },
    },
    {
      label: 'DELETE (reset)',
      run: async () => {
        const r = await fetch('/api/probe/counter', { method: 'DELETE' });
        const body = await r.json().catch(() => null);
        return { pass: r.status === 200 && body?.value === 0, observed: { status: r.status, body } };
      },
    },
  ],
};

const probeListPosts = {
  feature: 'api.listPosts()',
  description: 'Reads the public posts feed from KVStore via the Blocks Lambda. No auth required.',
  source: 'aws-blocks/index.ts → ApiNamespace listPosts',
  buttons: [
    {
      label: 'Call listPosts',
      run: async () => {
        const result = await api.listPosts();
        return { pass: Array.isArray(result), observed: { count: Array.isArray(result) ? result.length : -1, sample: Array.isArray(result) ? result.slice(0, 3) : result } };
      },
    },
  ],
};

const probeCheckAuth = {
  feature: 'api.authCheckAuth()',
  description: 'Returns the current session info if logged in, or null. Demonstrates Blocks auth round-trip.',
  source: 'aws-blocks/index.ts → ApiNamespace authCheckAuth',
  buttons: [
    {
      label: 'Call authCheckAuth',
      run: async () => {
        const result = await api.authCheckAuth();
        return { pass: result === null || (typeof result === 'object' && 'username' in result), observed: result };
      },
    },
  ],
};

const probeAuthFlow = {
  feature: 'api.authSignUp + authConfirmSignUp + authSignIn',
  description: 'Full auth flow: create disposable account, fetch the verification code, confirm, sign in. Cookie set as a result.',
  source: 'aws-blocks/index.ts → AuthBasic helpers',
  buttons: [
    {
      label: 'Run full auth flow',
      run: async () => {
        const username = `apitest-${Date.now()}@example.com`;
        const password = 'TestPass123!';
        await api.authSignUp(username, password);
        let code = null;
        for (let i = 0; i < 15 && !code; i++) {
          code = await api.authGetLastCode(username);
          if (!code) await new Promise((r) => setTimeout(r, 200));
        }
        if (!code) return { pass: false, observed: { step: 'authGetLastCode', got: null } };
        await api.authConfirmSignUp(username, code.code);
        const signin = await api.authSignIn(username, password);
        return { pass: !!signin?.username, observed: { username, signin } };
      },
    },
    {
      label: 'authSignOut',
      run: async () => {
        await api.authSignOut();
        const after = await api.authCheckAuth();
        return { pass: after === null, observed: { afterSignOut: after } };
      },
    },
  ],
};

const probeProfile = {
  feature: 'api.getProfile() (auth-protected)',
  description: 'Calls a protected Blocks endpoint. Returns the current user\'s profile or 401 if unauthenticated.',
  source: 'aws-blocks/index.ts → getProfile (uses auth.requireAuth)',
  buttons: [
    {
      label: 'Call getProfile',
      run: async () => {
        try {
          const result = await api.getProfile();
          return { pass: !!result?.username, observed: result };
        } catch (err) {
          return { pass: false, observed: { error: err instanceof Error ? err.message : String(err) } };
        }
      },
    },
  ],
};

const probeCrud = {
  feature: 'api.createPost / listMyPosts / deletePost (auth-protected)',
  description: 'Posts CRUD round-trip, auth-protected. Will fail with 401 if you have not signed in. Run the auth flow above first.',
  source: 'aws-blocks/index.ts → posts CRUD',
  buttons: [
    {
      label: 'Create + list + delete',
      run: async () => {
        try {
          const created = await api.createPost(`API test ${new Date().toISOString()}`, 'Created from /api-test page.');
          const myPosts = await api.listMyPosts();
          const deletion = await api.deletePost(created.id);
          return { pass: !!deletion?.success && Array.isArray(myPosts), observed: { created, myPostsCount: myPosts.length, deletion } };
        } catch (err) {
          return { pass: false, observed: { error: err instanceof Error ? err.message : String(err) } };
        }
      },
    },
  ],
};

const probeAuthApi = {
  feature: 'authApi (separate ApiNamespace)',
  description: 'The authApi namespace is the Blocks-owned alternative to the api namespace. Tests that multiple ApiNamespaces coexist.',
  source: 'aws-blocks/index.ts → authApi',
  buttons: [
    {
      label: 'List authApi members',
      run: async () => {
        const keys = Object.keys(authApi ?? {});
        return { pass: keys.length > 0, observed: { keys } };
      },
    },
  ],
};
</script>

<template>
  <main>
    <header :style="{ marginBottom: '24px' }">
      <h2 :style="{ margin: '0 0 4px 0' }">API Test Console — Nuxt</h2>
      <p :style="{ color: '#666', margin: 0 }">
        Click any button to invoke a route. Two route classes:
        <span :style="{ background: '#000', color: '#fff', padding: '2px 8px', borderRadius: '4px', marginLeft: '8px', fontSize: '12px' }">Framework</span>
        <span :style="{ marginLeft: '4px', fontSize: '13px' }">= server/api/* (shadowed by Blocks' /api/* CloudFront behavior)</span>
        <br />
        <span :style="{ background: '#00B894', color: '#000', padding: '2px 8px', borderRadius: '4px', marginRight: '4px', fontSize: '12px' }">Blocks</span>
        = ApiNamespace endpoints (route to Blocks Lambda)
      </p>
      <details :style="{ marginTop: '8px' }">
        <summary :style="{ cursor: 'pointer' }">config.json</summary>
        <pre :style="{ background: '#0d1117', color: '#c9d1d9', padding: '8px', borderRadius: '6px', fontSize: '12px' }">{{ JSON.stringify(config, null, 2) }}</pre>
      </details>
    </header>

    <h3 :style="{ borderTop: '1px solid #eee', paddingTop: '16px', marginBottom: '12px' }">
      <span :style="{ background: '#000', color: '#fff', padding: '3px 10px', borderRadius: '4px', fontSize: '14px' }">Framework</span>
      routes — Nuxt 4 / Nitro (<code>server/api/probe/*</code>)
    </h3>

    <ProbeCard v-bind="probeCookies" />
    <ProbeCard v-bind="probeEcho" />
    <ProbeCard v-bind="probeUpload" />
    <ProbeCard v-bind="probeStream" />
    <ProbeCard v-bind="probeHealth" />
    <ProbeCard v-bind="probeThrow" />
    <ProbeCard v-bind="probeSlow" />
    <ProbeCard v-bind="probeCatchall" />
    <ProbeCard v-bind="probeCounter" />

    <h3 :style="{ borderTop: '1px solid #eee', paddingTop: '16px', marginBottom: '12px', marginTop: '24px' }">
      <span :style="{ background: '#000', color: '#fff', padding: '3px 10px', borderRadius: '4px', fontSize: '14px' }">Framework</span>
      feature pages
    </h3>
    <ul :style="{ margin: '0 0 24px 18px' }">
      <li><NuxtLink to="/about">/about</NuxtLink> — prerendered (route rule prerender: true)</li>
      <li><NuxtLink to="/old-page">/old-page</NuxtLink> — should redirect to /about (route rule)</li>
      <li><NuxtLink to="/headers-test">/headers-test</NuxtLink> — extra headers via route rules</li>
      <li><NuxtLink to="/cookies-test">/cookies-test</NuxtLink> — useCookie / setCookie</li>
      <li><NuxtLink to="/streaming">/streaming</NuxtLink> — progressive hydration</li>
      <li><NuxtLink to="/error-boundary">/error-boundary</NuxtLink> — page throws, error.vue catches</li>
      <li><NuxtLink to="/server-action">/server-action</NuxtLink> — server-side counter</li>
    </ul>

    <h3 :style="{ borderTop: '1px solid #eee', paddingTop: '16px', marginBottom: '12px', marginTop: '24px' }">
      <span :style="{ background: '#00B894', color: '#000', padding: '3px 10px', borderRadius: '4px', fontSize: '14px' }">Blocks</span>
      routes — ApiNamespace (<code>aws-blocks/index.ts</code>)
    </h3>

    <ProbeCard v-bind="probeListPosts" />
    <ProbeCard v-bind="probeCheckAuth" />
    <ProbeCard v-bind="probeAuthFlow" />
    <ProbeCard v-bind="probeProfile" />
    <ProbeCard v-bind="probeCrud" />
    <ProbeCard v-bind="probeAuthApi" />
  </main>
</template>
