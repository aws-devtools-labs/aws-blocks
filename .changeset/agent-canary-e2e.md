---
"@aws-blocks/create-blocks-app": patch
---

feat: add an `agent` template with a deterministic e2e test

`npx @aws-blocks/create-blocks-app my-app --template agent` scaffolds an AI Agent
with a tool and `AuthBasic`-gated chat. Locally it runs on the built-in
`canned` provider, a deterministic fake model that needs no AWS account and no
LLM, so the shipped e2e test drives a plain-text turn and a tool-calling turn
over the real RPC boundary and checks the tool's side effect landed.
