---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

CORS guidance now points at the stack's `defaults.allowedOrigins` everywhere, the stack-level setting every Blocks compute picks up. The runtime warning for a disallowed origin says to add it to `defaults.allowedOrigins` instead of setting the `CORS_ALLOWED_ORIGINS` environment variable; the core README's production example configures `defaults.allowedOrigins` instead of calling `handler.addEnvironment`, credits the sandbox preset (not the CLI) for the localhost pattern, and explains where allowed origins come from (`defaults.allowedOrigins` and, with `Hosting`, the distribution's own domain); the umbrella security checklist follows suit.
