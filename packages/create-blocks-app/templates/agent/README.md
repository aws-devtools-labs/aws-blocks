# Blocks Agent App

A frontend on AWS Blocks with an **AI Agent** — model inference, tool calling,
and conversation persistence — end to end. Locally the agent runs on the
built-in **`canned` provider**: a deterministic, keyword-driven fake model that
speaks the real model-stream protocol with no AWS and no LLM, so `npm run dev`
and the e2e tests are fully reproducible. On deploy it runs against Amazon
Bedrock. Vite + vanilla DOM frontend.

> Created with `npx @aws-blocks/create-blocks-app my-app --template agent`

## Getting Started

```bash
npm run dev          # Start local dev server (canned model, no AWS needed)
npm run test:e2e     # Run API tests
npm run sandbox      # Deploy to AWS sandbox (real Bedrock model)
npm run sandbox:deploy # Deploy to AWS once and exit (no watch)
```

Open http://localhost:3000 after `npm run dev`, sign in, then chat. Ask the
agent to "save a note" to see it call a tool.

**Local model:** the agent's `model.local` is `{ provider: 'canned' }`. The
canned provider returns keyword-based text and, when a prompt mentions a tool's
name, emits a tool call so the agent runs your handler — all deterministic. To
use a real model in dev, set `model.local` to a `bedrock` or `openai-api`
provider in `aws-blocks/index.ts`. The deployed model is `model.deployed`
(`BedrockModels` presets, or a specific `modelId`).

## Project Structure

| Path | Purpose |
|------|---------|
| `aws-blocks/index.ts` | Backend: Agent (canned local model) + a `saveNote` tool, AuthBasic, requireAuth-gated API |
| `src/index.ts` | Frontend: Authenticator sign-in + a chat box |
| `test/e2e.test.ts` | Tests exercising a plain-text turn and a tool-calling turn |
| `index.html` | HTML shell |

## What's Included

- **Agent** — model inference + tool calling + conversation persistence. The
  `chat` method runs one turn server-side (`stream()` + `complete()`) and
  returns the final text; the browser gets request/response (subscribe to the
  Realtime channel for token streaming — see the Agent BB README).
- **A tool with a side effect** — `saveNote` writes into the KVStore. The e2e
  asserts the note landed, proving the model requested the call and the handler
  ran end to end.
- **AuthBasic** — `chat` is gated by `auth.requireAuth(context)`, so each turn
  is tied to a signed-in user.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Local dev with the canned model + mock storage |
| `npm run dev:stop` | Stop the local dev server this app started |
| `npm run test:e2e` | Test the API via direct imports |
| `npm run typecheck` | TypeScript type checking |
| `npm run sandbox` | Deploy backend to AWS, serve frontend locally |
| `npm run sandbox:deploy` | Deploy the backend to AWS once and exit (no watch, no dev server); for scripts and CI |
| `npm run sandbox:preview` | Deploy a hosted preview: the sandbox backend plus the app in preview shape (API Gateway, no CloudFront); prints the URL. Same stack as `sandbox`: a plain sandbox deploy removes the preview, and re-adding it gives a new URL. Tear down with `npm run sandbox:destroy` |
| `npm run deploy` | Full production deploy |
| `npm run sandbox:destroy` | Tear down sandbox resources; asks first in a terminal (`-- --yes` skips it) |
| `npm run destroy` | Tear down the production stack (asks first; `-- --yes` in CI) |
| `npm run secret -- set KEY` | Set a secret (also `list`, `remove KEY`) |
| `npm run config -- set KEY value` | Set a non-secret config value (also `list`, `remove KEY`) |
| `npm run typegen` | Regenerate secret/config key types; run it once and commit `.blocks/hosting-values.d.ts` before gating CI on `npm run typegen -- --check` |

Each script is an alias of the `cdk-blocks` CLI that ships with `@aws-blocks/blocks` (for example
`"deploy": "cdk-blocks deploy"`); run `npx --no -- cdk-blocks --help` to see every command and its options.
The dev server settings are in `package.json` under `"blocks": { "dev": … }`; `npm run dev -- --port 4000 --frontend-port 4100` overrides them.
`npm run destroy` asks before it deletes anything; in CI or a script, run `npm run destroy -- --yes`.

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
automatically). Start in `aws-blocks/index.ts` (backend) and `src/index.ts`
(frontend). Test via `npm run test:e2e`.
