---
"@aws-blocks/hosting": patch
"@aws-blocks/core": patch
---

Add a SvelteKit framework adapter. SvelteKit apps are now auto-detected (via
`@sveltejs/kit`) and deployed through `@sveltejs/adapter-node` running on Lambda
behind the Lambda Web Adapter (the existing `http-server` compute path), fronted
by CloudFront + S3. Supports SSR pages, `+server.js` endpoints, form actions,
server `load`, `hooks.server`, streaming, prerendered/SSG pages (served frozen
from S3), custom headers, cookies, redirects, `error()`, and `paths.base`. A
transparent build bridge wires `@sveltejs/adapter-node` when the app hasn't
configured it, so no manual setup is required. Patch (not minor) per the
pre-1.0 caret convention — the change is additive and backward-compatible.
