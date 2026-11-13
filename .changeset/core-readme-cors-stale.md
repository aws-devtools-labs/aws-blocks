---
"@aws-blocks/core": patch
---

docs: correct how `defaults.allowedOrigins` entries are matched for a separately hosted frontend

The README's "Production (frontend hosted separately)" section said every `allowedOrigins` entry is a regex, that an invalid regex falls back to a literal match, and that `https://app.example.com` also matches `https://appXexample.com`. A plain origin such as `https://app.example.com` is matched exactly, and an invalid entry fails synth (or is ignored and logged at runtime); the section now says so and links to the `allowedOrigins` rules above it. The Pipeline section now links to the `@aws-blocks/pipeline` README.
