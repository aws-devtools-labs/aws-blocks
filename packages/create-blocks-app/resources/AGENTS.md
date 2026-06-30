# Agent Guide

## Quick Reference

- **Backend:** `aws-blocks/index.ts` — APIs, auth, data models
- **Frontend:** `src/` — imports backend APIs via `import { api } from 'aws-blocks'`
- **Tests:** `test/e2e.test.ts` — run with `npm run test:e2e`
- **Full guide:** `node_modules/@aws-blocks/blocks/README.md` — architecture, workflow, best practices, common mistakes
- **Block catalog + decision tree:** `node_modules/@aws-blocks/blocks/docs/index.md`
- **Per-block docs:** `node_modules/@aws-blocks/blocks/docs/<package-name>.md`

## Workflow

1. Make changes to backend (`aws-blocks/index.ts`) or frontend (`src/`)
2. Test with `npm run test:e2e` — starts a dev server automatically if one isn't running
3. For faster iteration: run `npm run dev &` in the background, then run `npm run test:e2e` repeatedly (reuses the running server)
4. Do NOT use curl/fetch against the API unless troubleshooting connectivity

## Rules

- **Use Building Blocks** for all persistence and cloud abstractions — never local files, in-memory arrays, or local databases.
- **Read block docs** at `node_modules/@aws-blocks/blocks/docs/<package-name>.md` before using a block.
- **The JSON-RPC transport is invisible** — do not construct RPC payloads manually. Import and call the typed API directly.

## Deploying (requires AWS credentials)

- `npm run sandbox` — deploy backend to AWS, serve frontend locally
- `npm run deploy` — full production deploy to AWS
- `npm run sandbox:destroy` — tear down sandbox resources
