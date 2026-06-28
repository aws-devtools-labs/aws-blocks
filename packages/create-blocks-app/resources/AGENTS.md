# Agent Guide

## Quick Reference

- **Backend:** `aws-blocks/index.ts` — APIs, auth, data models
- **Frontend:** `src/` — imports backend APIs via `import { api } from 'aws-blocks'`
- **Tests:** `test/e2e.test.ts` — run with `npm run test:e2e`
- **AWS Blocks docs** ship inside the `@aws-blocks/blocks` package. Find the docs folder once: `node -p "require('path').dirname(require.resolve('@aws-blocks/blocks/docs/README.md'))"` (fallback: `node_modules/@aws-blocks/blocks/docs`). Read everything relative to it: `README.md` (dev guide + catalog + decision tree — start here), then `<block>/README.md`, `<block>/API.md`, `<block>/DESIGN.md`.

## Workflow

1. Make changes to backend (`aws-blocks/index.ts`) or frontend (`src/`)
2. Test with `npm run test:e2e` — starts a dev server automatically if one isn't running
3. For faster iteration: run `npm run dev &` in the background, then run `npm run test:e2e` repeatedly (reuses the running server)
4. Do NOT use curl/fetch against the API unless troubleshooting connectivity

## Rules

- **Use Building Blocks** for all persistence and cloud abstractions — never local files, in-memory arrays, or local databases.
- **Read block docs** before using a block — start with its `README.md`, then `API.md` / `DESIGN.md` as needed (see the **AWS Blocks docs** bullet above for where the docs folder lives).
- **The JSON-RPC transport is invisible** — do not construct RPC payloads manually. Import and call the typed API directly.

## Deploying (requires AWS credentials)

- `npm run sandbox` — deploy backend to AWS, serve frontend locally
- `npm run deploy` — full production deploy to AWS
- `npm run sandbox:destroy` — tear down sandbox resources
