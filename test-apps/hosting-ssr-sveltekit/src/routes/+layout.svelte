<script lang="ts">
  import { base } from '$app/paths';
  let { children } = $props();
</script>

<div style="font-family: system-ui, sans-serif; padding: 2rem; max-width: 860px; margin: 0 auto; color: #333;">
  <header style="margin-bottom: 2rem; border-bottom: 1px solid #eee; padding-bottom: 1rem;">
    <h1 style="margin: 0;">
      <a href="{base}/" style="text-decoration: none; color: inherit;">🧡 Blocks SvelteKit</a>
      <span style="margin-left: 0.5rem; font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 4px; background: #ff3e00; color: #fff; vertical-align: middle;">SvelteKit</span>
    </h1>
    <p style="color: #666; margin: 0.25rem 0 0;">SvelteKit (adapter-node) · SSR Hosting E2E Test</p>
    <nav style="display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 0.75rem;">
      <a href="{base}/">Home</a>
      <a href="{base}/about">About (SSG)</a>
      <a href="{base}/ssr">SSR</a>
      <a href="{base}/form">Form</a>
      <a href="{base}/streaming">Streaming</a>
      <a href="{base}/headers">Headers</a>
      <a href="{base}/cookies">Cookies</a>
      <a href="{base}/redirect">Redirect</a>
      <a href="{base}/error-demo">Error</a>
    </nav>
  </header>
  {@render children()}
</div>
