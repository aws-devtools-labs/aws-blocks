# `@aws-blocks/bb-agentcore-memory`

A custom **AWS Block** for [Amazon Bedrock AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html).

Give your agents memory with **one line** — and the *same code* runs locally (no AWS account) and on real AgentCore Memory in production.

```ts
const memory = new AgentCoreMemory(scope, 'assistant-memory', {
  eventExpiryDays: 90,
  strategies: [
    { type: 'semantic', name: 'facts' },
    { type: 'userPreference', name: 'prefs' },
    { type: 'summary', name: 'session-summary' },
  ],
});
```

## What it models

AgentCore Memory has two tiers; this block mirrors both:

| Tier | AgentCore concept | Block method |
| --- | --- | --- |
| **Short-term** | immutable, timestamped `events` scoped by `actorId` + `sessionId` | `createEvent`, `listEvents`, `listSessions` |
| **Long-term** | `memory records` extracted from events by *strategies*, stored under hierarchical *namespaces*, retrieved by semantic search | `retrieveMemories` |

## API

```ts
await memory.createEvent({ actorId, sessionId, role, text });        // write a turn
await memory.listEvents({ actorId, sessionId });                    // recent turns
await memory.retrieveMemories({ namespace, query, topK });          // semantic recall
await memory.listSessions({ actorId });                             // a user's sessions
```

Namespaces follow AgentCore conventions and expand `{actorId}` / `{sessionId}`:
`semantic → /facts/{actorId}`, `userPreference → /preferences/{actorId}`,
`summary → /summaries/{actorId}/{sessionId}`.

## The three layers

This block ships the canonical AWS Blocks four-export shape (`cdk` / `aws-runtime` / `default`=mock / browser), selected automatically by execution context:

- **`index.mock.ts`** (local dev) — simulates AgentCore Memory entirely in-process,
  persisted to `.bb-data/<id>/memory.json`. Long-term "extraction" runs locally with
  deterministic heuristics; semantic retrieval is approximated with **bag-of-words
  cosine similarity**. This is the spirit of AgentCore's local Docker dev runtime:
  *develop and test the full memory loop offline, same app code.*
- **`index.aws.ts`** (Lambda runtime) — calls the real AgentCore **data plane**
  (`@aws-sdk/client-bedrock-agentcore`): `CreateEvent`, `ListEvents`,
  `RetrieveMemoryRecords`, `ListSessions`.
- **`index.cdk.ts`** (deploy) — provisions `AWS::BedrockAgentCore::Memory` with the
  configured strategies + an execution role, grants the Blocks Lambda data-plane IAM,
  and injects the memory id into the handler environment.

### Local vs AWS — the one honest difference

Real AgentCore extraction/retrieval is LLM- and vector-backed. The local mock uses
lexical heuristics, so semantic recall locally needs lexical overlap between the query
and stored text. The **API, data model, and namespaces are identical**, so code written
against the mock runs unchanged on AWS, where retrieval becomes truly semantic.

## Test

```bash
npm run build -w @aws-blocks/bb-agentcore-memory
npm test     -w @aws-blocks/bb-agentcore-memory
```
