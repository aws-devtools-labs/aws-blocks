<script lang="ts">
  // Baked at build time — a fresh timestamp on every reload would mean the SSR
  // Lambda is re-rendering instead of S3 serving the frozen prerender.
  const buildTimestamp = new Date().toISOString();
</script>

<main>
  <h2 data-testid="page-id" data-page="about">About</h2>
  <p data-testid="about-marker">Prerendered (SSG), served from S3.</p>
  <p>Build timestamp: <code data-testid="about-build-ts">{buildTimestamp}</code></p>

  <section data-testid="validation-panel" data-overall="pass">
    <p data-testid="validation-summary">Static page frozen at build time.</p>
    <span data-testid="validation-check" data-status="pass" data-check-name="prerendered"></span>
  </section>
</main>
