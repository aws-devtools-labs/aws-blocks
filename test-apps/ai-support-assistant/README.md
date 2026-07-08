# Example 3 (Advanced) — AI Support Assistant

A memory-augmented, tool-using support assistant built on the two **custom
AgentCore blocks** (`AgentCoreMemory`, `AgentCoreGateway`) composed with
first-party blocks — running end-to-end **locally, with no AWS account**.

## Architecture

```
  browser ──RPC──▶ api (ApiNamespace)
                      │  chat(userId, sessionId, text)
                      ▼
                SupportAssistant   ── the "agent runtime" loop ──
                  1. remember  ─▶ AgentCoreMemory.createEvent
                  2. recall    ─▶ AgentCoreMemory.retrieveMemories  (facts + prefs)
                  3. plan      ─▶ AgentCoreGateway.callTool
                  4. respond   ◀─ tool results + recalled memory
                  5. remember  ─▶ AgentCoreMemory.createEvent (assistant turn)

  AgentCoreGateway 'tools'  (MCP tools/list + tools/call)
     ├─ get_order_status ─▶ KVStore 'orders'
     ├─ create_ticket    ─▶ KVStore 'tickets'  ──▶ AsyncJob 'enrich' (priority)
     └─ lookup_faq
```

## Blocks used

| Block | Role |
| --- | --- |
| **`AgentCoreMemory`** (custom) | per-user long-term memory — facts & preferences recalled across sessions |
| **`AgentCoreGateway`** (custom) | exposes the assistant's tools as MCP tools the agent calls |
| `KVStore` ×2 | orders catalog + tickets store |
| `AsyncJob` | background ticket-priority enrichment, off the request path |

## What it demonstrates

- **The AgentCore runtime loop, simulated locally** — `SupportAssistant`
  (`aws-blocks/assistant.ts`) mirrors how AgentCore Runtime orchestrates an agent:
  remember → recall → plan → act (tools) → respond → remember. It is fully
  deterministic and offline-testable.
- **Cross-session memory** — a fact or preference stated in one session is recalled
  in a later session for the same user, and **isolated per user** (no leakage).
- **Tools as MCP** — capabilities are registered once and surfaced through the gateway's
  `tools/list` / `tools/call`, the same contract a real or external agent would use.
- **Background work** — opening a ticket fires an `AsyncJob` that classifies its priority
  without blocking the reply.

## The production upgrade path

The rule-based planner in `SupportAssistant` is exactly where the first-party
**`Agent`** block (a real LLM via Strands/Bedrock) drops in. The tools become the
Agent's `tools`, and `AgentCoreMemory` provides the conversational memory — the
Memory/Gateway wiring is unchanged. On AWS, the same code runs against real AgentCore
Memory and Gateway resources (provisioned by the blocks' CDK layers).

## Run

```bash
npm test -w example-ai-support-assistant
```

The test drives multi-turn conversations, verifies gateway tool calls, cross-session
fact/preference recall, per-user isolation, and async ticket enrichment.
