<script lang="ts">
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<main>
  <h2 data-testid="page-id" data-page="cookies">Cookies</h2>
  <p data-testid="cookies-marker">Cookie set by hooks.server, read by server load.</p>
  <p>sk_visit: <code data-testid="cookie-visit">{data.visit ?? '(none)'}</code></p>
</main>
