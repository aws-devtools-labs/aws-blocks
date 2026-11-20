# AWS CDK Blocks Agent App

A frontend on CDK Blocks with an **AI Agent** — model inference and tool
calling — end to end. Locally the agent runs on the built-in `canned` provider
(no AWS, no LLM); deployed, it runs against Amazon Bedrock. Vite + vanilla DOM
frontend.

## Getting Started

```bash
npm run dev          # Start local dev server (canned model, no AWS needed)
npm run test:e2e     # Run API tests
npm run sandbox      # Deploy to AWS sandbox (real Bedrock model)
```

Open http://localhost:3000 after `npm run dev`, sign in, then chat. Ask the
agent to "save a note" to see it call a tool.

**Local model:** the agent's `model.local` is `{ provider: 'canned' }`. The
canned provider returns keyword-based text and, when a prompt mentions a tool's
name, emits a tool call so the agent runs your handler — all deterministic. To
use a real model in dev, set `model.local` to a `bedrock` or `openai-api`
provider in `cdk-blocks/index.ts`. The deployed model is `model.deployed`
(`BedrockModels` presets, or a specific `modelId`).

## Project Structure

| Path | Purpose |
|------|---------|
| `cdk-blocks/index.ts` | Backend: Agent (canned local model) + a `saveNote` tool, Auth, requireAuth-gated API |
| `src/index.ts` | Frontend: Authenticator sign-in + a chat box |
| `test/e2e.test.ts` | Tests exercising a plain-text turn and a tool-calling turn |
| `index.html` | HTML shell |

## What's Included

- **Agent** — model inference + tool calling.
  - The `chat` method runs one turn server-side (`stream()` + `complete()`)
    and returns the final text, so the browser gets request/response.
  - For token streaming, subscribe to the Realtime channel (`npm run docs Agent`).
  - Each turn is independent. To keep history across turns, create a
    conversation with `createConversationId()` and pass its id to `stream()`.
- **A tool with a side effect** — `saveNote` writes into the KVStore;
  `test/e2e.test.ts` checks that the note is there.
- **Auth** — `chat` is gated by `auth.requireAuth(context)`, so each turn
  is tied to a signed-in user. Sign-up confirms the email with a 6-digit code,
  which `npm run dev` prints in its terminal locally.

## Commands

`npm run help` lists every command. `AGENTS.md` covers the development, test and deploy commands.

`npm run typegen` regenerates the secret and config key types; run it once and commit `.cdk-blocks/hosting-values.d.ts` before gating CI on `npm run typegen -- --check`.

## For Agents

Building Block docs: `npm run docs` lists the blocks, and `npm run docs <Block>...` prints their docs (`npm run docs -- --help` for more). `AGENTS.md` explains the rest.
