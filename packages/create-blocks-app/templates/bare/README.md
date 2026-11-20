# AWS CDK Blocks App (bare)

Minimal full-stack TypeScript app with the CDK Blocks framework.

## Getting Started

```bash
npm run dev          # Start local dev server (mocks, no AWS needed)
npm run test:e2e     # Run API tests
npm run sandbox      # Deploy to AWS sandbox
```

Open http://localhost:3000 after `npm run dev`.

## Project Structure

| Path | Purpose |
|------|---------|
| `cdk-blocks/index.ts` | Backend: APIs and Building Blocks |
| `src/index.ts` | Frontend: imports backend APIs directly |
| `test/e2e.test.ts` | Tests: verifies API via direct imports |
| `index.html` | HTML shell |

## Commands

`npm run help` lists every command. `AGENTS.md` covers the development, test and deploy commands.

`npm run typegen` regenerates the secret and config key types; run it once and commit `.cdk-blocks/hosting-values.d.ts` before gating CI on `npm run typegen -- --check`.

## Stack naming

A sandbox stack's name ends in an identifier that is per machine, stored in `.cdk-blocks-sandbox/sandbox-id.txt` (gitignored). `AGENTS.md` describes the stack names and how to rename them.

## For Agents

Building Block docs: `npm run docs` lists the blocks, and `npm run docs <Block>...` prints their docs (`npm run docs -- --help` for more). `AGENTS.md` explains the rest.
