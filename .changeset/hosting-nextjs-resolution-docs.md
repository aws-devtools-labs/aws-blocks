---
"@aws-blocks/hosting": patch
---

Document Next.js module resolution in the README: which export condition each Next.js graph resolves (`react-server` for Server Components, route handlers and Server Actions; `import` for the SSR pass of a Client Component; `browser` for the browser bundle), verified against Next 16 under both Turbopack and webpack.

Also documents the `serverExternalPackages` requirement for blocks that load WASM or native assets via `new URL(..., import.meta.url)` — `@aws-blocks/bb-data` needs it, or PGlite fails with an "instance of URL" TypeError under both bundlers.
