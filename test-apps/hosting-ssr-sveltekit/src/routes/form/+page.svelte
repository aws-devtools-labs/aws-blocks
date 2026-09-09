<script lang="ts">
  import { enhance } from '$app/forms';
  import type { ActionData } from './$types';
  let { form }: { form: ActionData } = $props();
</script>

<main>
  <h2 data-testid="page-id" data-page="form">Form Actions</h2>
  <p>Submitting POSTs to the SSR Lambda via a SvelteKit form action.</p>

  <form method="POST" use:enhance data-testid="greet-form">
    <input name="name" data-testid="name-input" placeholder="Your name" />
    <button type="submit" data-testid="greet-submit">Greet</button>
  </form>

  {#if form?.greeting}
    <p data-testid="greet-result">{form.greeting}</p>
  {:else if form?.error}
    <p data-testid="greet-error">{form.error}</p>
  {/if}
</main>
