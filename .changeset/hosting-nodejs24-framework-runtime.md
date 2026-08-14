---
"@aws-blocks/hosting": patch
---

fix(hosting): deploy SSR framework Lambdas on nodejs24.x and throw on unrecognized runtimes instead of silently falling back to nodejs20.x

SSR framework compute (Nuxt/Nitro, Astro, SvelteKit, Next.js regional) now runs on
`nodejs24.x` via a shared `FRAMEWORK_COMPUTE_RUNTIME` constant, and `resolveRuntime()`
recognizes `nodejs24.x`, defaults to it when no runtime is declared, and throws
`UnsupportedRuntimeError` for unrecognized runtimes rather than silently returning
Node 20. Lambda@Edge compute intentionally stays on `nodejs20.x`
(`FRAMEWORK_EDGE_COMPUTE_RUNTIME`) because the edge runtime set is narrower and the
OpenNext edge bundle patch targets Node 20 ESM semantics.
