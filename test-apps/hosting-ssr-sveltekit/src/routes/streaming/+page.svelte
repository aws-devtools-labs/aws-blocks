<script lang="ts">
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<main>
  <h2 data-testid="page-id" data-page="streaming">Streaming</h2>
  <p data-testid="stream-eager">{data.eager}</p>

  {#await data.deferred}
    <p data-testid="stream-pending">Streaming…</p>
  {:then value}
    <p data-testid="stream-resolved">{value}</p>
  {/await}
</main>
