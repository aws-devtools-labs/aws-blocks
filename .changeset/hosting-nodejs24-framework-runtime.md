---
"@aws-blocks/hosting": patch
---

fix(hosting): deploy SSR framework Lambdas on nodejs24.x and throw on unrecognized runtimes instead of silently falling back to nodejs20.x

SSR framework compute (Nuxt/Nitro, Astro, SvelteKit, Next.js regional) now runs on
`nodejs24.x` via a shared `FRAMEWORK_COMPUTE_RUNTIME` constant, and `resolveRuntime()`
recognizes `nodejs24.x`, defaults to it when no runtime is declared, and throws
`UnsupportedRuntimeError` for unrecognized runtimes rather than silently returning
Node 20. Lambda@Edge compute (`FRAMEWORK_EDGE_COMPUTE_RUNTIME`) is bumped to
`nodejs24.x` as well: Lambda@Edge draws Node.js versions from the same managed runtime
table as regional Lambda, where `nodejs24.x` is supported and `nodejs20.x` is already
past deprecation. The OpenNext edge bundle banner patch was revalidated — the crash it
works around comes from ES Module namespace exports being non-writable per spec, not
from any Node-20-specific behavior.
