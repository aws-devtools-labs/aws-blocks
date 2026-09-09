<script lang="ts">
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<main>
  <h2 data-testid="page-id" data-page="headers">Custom Headers</h2>
  <p data-testid="headers-marker">This response carries x-stress-test + s-maxage.</p>
  <p>Rendered at: <code>{data.at}</code></p>
</main>
