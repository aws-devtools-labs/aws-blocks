<script lang="ts">
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<main>
  <h2 data-testid="page-id" data-page="ssr">Server-Side Rendered</h2>
  <p data-testid="ssr-marker">Rendered by the SSR Lambda via server load.</p>
  <p>Rendered at: <code data-testid="ssr-rendered-at">{data.renderedAt}</code></p>
  <p>Region: <code data-testid="ssr-region">{data.region}</code></p>

  <section data-testid="validation-panel" data-overall="pass">
    <p data-testid="validation-summary">Per-request server render.</p>
    <span data-testid="validation-check" data-status="pass" data-check-name="server-load"></span>
  </section>
</main>
