<script lang="ts">
  import { page } from '$app/state';
</script>

<main>
  <h2 data-testid="page-id" data-page="error">Error {page.status}</h2>
  <p data-testid="error-message">{page.error?.message}</p>
</main>
