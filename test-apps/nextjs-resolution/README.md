# Next.js resolution tripwire

Blocks' architecture rests on Node conditional exports. This app pins down **which
export condition each Next.js graph actually resolves**, so a Next.js or bundler
upgrade cannot silently change it.

Every condition in `conditions/package.json` points at a *different* marker module,
and the test asserts what each context received. (The fixture directory is deliberately
not named `aws-blocks/`: it cannot satisfy the canonical export map that
`check:exports-consistency` enforces on real backends, because its whole purpose is to
make each condition resolve somewhere distinct.)

| Context | Expected condition |
|---|---|
| Server Component | `react-server` |
| Route handler | `react-server` |
| Server Action | `react-server` |
| Client Component, SSR pass | `import` |
| Client Component, browser bundle | `browser` |

The `react-server` marker constructs **real** blocks (`KVStore` + a PGlite-backed
`Database`) and round-trips data, so the test also proves server code can use blocks
in process rather than over RPC.

Two findings this guards:

1. `react-server` is set natively by Next.js in every server context, so mapping it to
   the real backend needs **no custom condition name** and no bundler configuration.
2. The SSR pass of a Client Component resolves `import`, **not** `browser`. `import`
   must therefore point at the RPC client — otherwise Client Components get the real
   backend during SSR and the RPC client after hydration.

Blocks that load WASM or native assets via `new URL(..., import.meta.url)` must be
listed in `serverExternalPackages`; see `next.config.ts`.

```bash
npm run test:e2e:local   # next build, then assert against the standalone server
```
