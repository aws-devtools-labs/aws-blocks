# Blocks Next.js App

A Next.js 16 App Router frontend on AWS Blocks. Shows both halves of the App
Router calling the same Blocks backend: a **Server Component** that fetches on
the server, and a **Client Component** that calls the API from the browser.

> Created with `npx @aws-blocks/create-blocks-app my-app --template nextjs`

## Getting Started

```bash
npm run dev          # Start the Next.js dev server (mocks, no AWS needed)
npm run test:e2e     # Run the e2e test against the dev server
npm run sandbox      # Deploy to AWS sandbox
```

Open http://localhost:3000 after `npm run dev`.

## Project Structure

| Path | Purpose |
|------|---------|
| `aws-blocks/index.ts` | Backend: the `api` namespace (`greet`, `getServerTime`) |
| `src/app/page.tsx` | Server Component — fetches on the server |
| `src/app/client.tsx` | Client Component — calls the API from the browser |
| `src/app/layout.tsx` | Root layout |
| `src/app/error.tsx` | Error boundary |
| `test/e2e.test.ts` | Boots the dev server and asserts the page renders |

## What's Included

- **App Router** — Server + Client Components in `src/app/`.
- **Blocks API** — a public `api` namespace (`greet`, `getServerTime`); no auth
  by default. Add an auth block and call `requireAuth(context)` first to gate a
  method (see the block's README).
- **Standalone output** — `next.config.ts` sets `output: 'standalone'` so the
  build packages for Lambda deployment.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Next.js dev server with mock storage |
| `npm run test:e2e` | Boot the dev server and test the rendered page |
| `npm run typecheck` | TypeScript type checking |
| `npm run build` | `next build` (standalone output) |
| `npm run start` | Serve the production build locally |
| `npm run sandbox` | Deploy backend to AWS, serve frontend locally |
| `npm run deploy` | Full production deploy |
| `npm run sandbox:destroy` | Tear down sandbox resources |
| `npm run destroy` | Tear down the production stack |

## Stack naming

Your CloudFormation stack names are derived from the `stackId` in
`.blocks/config.json`, generated at scaffold time from your project name plus a
random suffix (e.g., `my-app-a3x9kf`). Production deploys as `<stackId>-prod`
and sandbox as `<stackId>-<username>-<random>`. To rename, edit `stackId`, or
`aws-blocks/index.cdk.ts` for dynamic naming logic.

## For Agents

Full Building Block documentation: `node_modules/@aws-blocks/blocks/README.md`

**Do not use local files or in-memory storage** — use Building Blocks for all
data persistence and cloud abstractions (they mock locally and deploy to AWS
automatically). The backend lives in `aws-blocks/index.ts`; the frontend calls
it from `src/app/`. Test via `npm run test:e2e`.
