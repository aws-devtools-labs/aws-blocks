---
"@aws-blocks/core": minor
---

Report the hosting framework in CLI telemetry. The `Hosting` construct records its resolved framework during synth and the deploy/sandbox orchestrator attaches it to the telemetry event, gated to the values the ingestion schema accepts (`nextjs`, `nitro`, `nuxt`, `astro`, `sveltekit`, `spa`, `static`). Backend-only projects report no framework.
