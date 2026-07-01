# AgentCore Memory — Design

Internal design notes for extenders and advanced users. See [README.md](./README.md)
for usage.

## Layer architecture

| Layer | File | Role |
| --- | --- | --- |
| Mock | `index.mock.ts` | in-process simulation, persisted to `.bb-data/{fullId}/memory.json` |
| AWS runtime | `index.aws.ts` | Amazon Bedrock AgentCore data plane (`@aws-sdk/client-bedrock-agentcore`) |
| CDK | `index.cdk.ts` | provisions `AWS::BedrockAgentCore::Memory` + IAM + env injection |
| Browser | `index.browser.ts` | throwing stub (server-only block) |

All layers expose the same public surface (`createEvent`, `listEvents`,
`retrieveMemories`, `listSessions`); `index.test.ts` asserts parity.

## Infrastructure (CDK)

- `AWS::BedrockAgentCore::Memory` with `EventExpiryDuration` and `MemoryStrategies`
  (mapped from the block's `strategies` option). When strategies are configured, an
  execution role (`bedrock-agentcore.amazonaws.com`) is created for long-term
  extraction.
- The resource `Name` is sanitized to the service pattern `^[a-zA-Z][a-zA-Z0-9_]{0,47}$`
  (see `naming.ts: memoryResourceName`).
- The Blocks Lambda is granted the data-plane actions (`CreateEvent`, `ListEvents`,
  `RetrieveMemoryRecords`, `ListSessions`, …) scoped to the memory ARN.
- The memory id (`getAtt('MemoryId')`) is injected into the handler environment under
  the key from `naming.ts: memoryEnvVar`; the AWS runtime layer reads it back.

## Resource handle injection

CDK → runtime handoff uses the env-var convention (not deterministic naming), because
the AgentCore memory id is allocated by the service at create time. `memoryEnvVar(fullId)`
is the single source of truth shared by the CDK (writer) and AWS (reader) layers.

## Mock parity gaps

The mock faithfully mirrors the data model (events, records, namespaces, strategy
types) but differs from the managed service in two honest ways:

1. **Extraction & retrieval are lexical, not LLM/vector.** Long-term extraction uses
   deterministic heuristics (`extraction.ts`): semantic facts are declarative
   sentences (questions are skipped, matching what an LLM extractor would do);
   preferences are cue-phrase matches; summaries are rolling per-session. Retrieval
   scores by bag-of-words cosine similarity. The API, namespaces, and data model are
   identical, so app code is unchanged on AWS, where retrieval becomes truly semantic.
2. **Read-not-found semantics.** On AWS a read for an actor/session/namespace with no
   data yet returns `ResourceNotFoundException`; the AWS layer catches it and returns
   `[]` so both layers behave identically (empty, not error). Writes still throw.
3. **Event `metadata`.** The mock stores and returns per-event `metadata`; the AWS layer
   echoes it on the `createEvent` return but does not yet persist it to AgentCore (its
   `MetadataValue` union needs typed mapping), so it is absent from `listEvents` on AWS.
   Tracked as a follow-up.

## Serialization

Mock state is a single JSON document (`{ events, records }`) per block instance under
`.bb-data/{fullId}/memory.json` (D-001). Records carry their expanded namespace, so
retrieval is a namespace-prefix filter plus similarity ranking.
