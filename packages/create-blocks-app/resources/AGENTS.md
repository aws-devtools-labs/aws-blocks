# Agent Guide

## Quick Reference

- **Backend:** `aws-blocks/index.ts` — APIs, auth, data models
- **Frontend:** `src/` — imports backend APIs via `import { api } from 'aws-blocks'`
- **Tests:** `test/e2e.test.ts` — run with `npm run test:e2e`
- **Docs (dev guide + block catalog + decision tree, then per-block API/DESIGN):** bundled in `@aws-blocks/blocks` — see [Reading the Building Block docs](#reading-the-building-block-docs).

## Reading the Building Block docs

The `@aws-blocks/blocks` package ships its full documentation under `docs/`. Locate it by **resolution first** (version-correct, independent of where the package is installed), and fall back to a hard-coded `node_modules` path only if resolution fails.

**Primary — resolve, then read.** The dev guide (architecture, workflow, best practices, common mistakes) plus the block catalog and decision tree all live in one file:

```bash
node -e "console.log(require.resolve('@aws-blocks/blocks/docs/README.md'))"
```

Read the path it prints. For a specific block, resolve its docs the same way and read them in order — `README.md` (overview, start here), then `API.md` (exact method signatures / option types) and `DESIGN.md` (architecture & rationale) as needed:

```bash
node -e "console.log(require.resolve('@aws-blocks/blocks/docs/bb-distributed-table/README.md'))"
```

Swap `bb-distributed-table` for the block you need; the catalog in `docs/README.md` lists every block.

**Fallback — if resolution fails**, read the files directly:

- Dev guide + catalog + decision tree: `node_modules/@aws-blocks/blocks/docs/README.md`
- Per-block: `node_modules/@aws-blocks/blocks/docs/<block>/{README,API,DESIGN}.md`

## Workflow

1. Make changes to backend (`aws-blocks/index.ts`) or frontend (`src/`)
2. Test with `npm run test:e2e` — starts a dev server automatically if one isn't running
3. For faster iteration: run `npm run dev &` in the background, then run `npm run test:e2e` repeatedly (reuses the running server)
4. Do NOT use curl/fetch against the API unless troubleshooting connectivity

## Rules

- **Use Building Blocks** for all persistence and cloud abstractions — never local files, in-memory arrays, or local databases.
- **Read block docs** before using a block — resolve `@aws-blocks/blocks/docs/<block>/README.md` (see [Reading the Building Block docs](#reading-the-building-block-docs)), then `API.md` / `DESIGN.md` as needed.
- **The JSON-RPC transport is invisible** — do not construct RPC payloads manually. Import and call the typed API directly.

## Deploying (requires AWS credentials)

- `npm run sandbox` — deploy backend to AWS, serve frontend locally
- `npm run deploy` — full production deploy to AWS
- `npm run sandbox:destroy` — tear down sandbox resources
