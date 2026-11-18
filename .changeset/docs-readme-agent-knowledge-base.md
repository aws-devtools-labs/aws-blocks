---
"@aws-cdk-blocks/bb-agent": patch
"@aws-cdk-blocks/bb-knowledge-base": patch
"aws-cdk-blocks": patch
---

docs(bb-agent, bb-knowledge-base): the Agent README shows the backend that the `createChat` example calls and lists every error case; model presets and Bedrock access are in `MODELS.md`; the KnowledgeBase README states the real `chunkOverlap` and `maxResults` rules.

**`bb-agent` README, corrections**

- The `createChat` example called `api.agentStream`, `api.agentResume`, `api.agentGetChannel` and three more methods that no backend in the README defined. The backend `ApiNamespace` is now shown with those names. The `subscribe` callback of `realtimeTransport` narrows its second argument with `typeof` before it calls `channel.subscribe()`.
- `InvalidModelConfig`: the list now says which cases the constructor throws (invalid `maxLlmCalls`, `maxToolIterations` or `sessionScope`), which `stream()` and `resume()` throw (a `context` that does not match `toolContextSchema`), and which fail the turn, where `complete()` rejects with `StreamFailed`. A `bedrock` model without a `modelId` and a model with an unknown `provider` fail the health check instead and end in `ModelUnavailable` when no candidate is left.
- `PersistenceRequired` is also thrown by `stream()` and `resume()` without `options.userId` on an agent with persistence. `InterruptRequired` is also thrown by `resume()` with an empty `responses` array or without `options.conversationId`. `InvalidUsage` also covers an invalid channel name and `chat.subscribe()` without a `channelId`.
- The `createChat` section no longer says the runtime is "Lambda + Realtime"; the loop runs on Bedrock AgentCore Runtime, as "What it provisions (AWS)" states.
- The `model` option is `{ deployed?, local? }`, not `{ deployed, local? }`.
- The fallback example sets `apiKey: 'ollama'` on its `openai-api` candidate. Without a key that candidate passes the health check and then fails the turn.
- Reconnect recovery said "a bounded failsafe"; it now says `loading` is cleared and `onError` reports a timeout after 11 minutes without a chunk.
- `createChat`, not the deprecated `useChat`, is named for subscribe-before-send ordering and for which message roles reach the UI.

**`bb-agent` README, added**

- `### Options` has a Default column and rows for `removalPolicy` and `logger`. `## Errors` has an `error.name` column.
- Tables for the `createChat` options, the methods of the controller it returns, the `ConversationManagerConfig` fields and the `InterruptResponse` fields; the two rules for the `refresh` callback.

**`bb-agent` README, moved and removed**

- Bedrock presets, Ollama presets, Bedrock guardrails, health checks, API key management, Bedrock access and Bedrock via Mantle are in `MODELS.md`, which ships in the package. The README keeps the `model` option table and the deployed, local and fallback examples.
- `### Options` and `## Errors` follow the method table. `Authorization`, `Model Configuration` and `Limiting runaway cost` are top-level sections; message roles, the persisted message shape and conversation records are under `## Conversation history`.
- The `useChat` section is a table of where `useChat` and `createChat` differ, including that only `useChat`'s `loadConversation()` subscribes to the channel. The `useChat` samples and the "Full Examples" section are removed.
- Three `searchDocs` examples remain of five; each sets `untrustedOutput: true` and takes its filter from the tool context. The complete example is "Use as an Agent tool" in the KnowledgeBase README.
- "Declaring tools", "Streaming Mode", "Reading conversation history", "Use Local LLM" and "Best Practices" are removed; their facts are in the method table, the options table and the neighbouring sections.

**`bb-agent` `MODELS.md`**

- `## AWS Credentials (Bedrock)` is `## Bedrock model access` and leads with a table of error message, cause and fix: the use case details form, the AWS Marketplace subscription, account availability, and global versus regional inference profiles.

**`bb-knowledge-base` README**

- `chunkOverlap` was "0–100" in the options table and "1–99" under "Local development". It is 1–99 on AWS, and the mock also accepts 0.
- `maxResults` said "Range: 1–100". A value outside the range is clamped, and a non-integer throws `ValidationError`.
- `waitUntilSynced()` has an options table (default, minimum, jitter) and a table of which poll failures are retried and which are thrown at once.
- `## Error Handling` is `## Errors`, directly after `## API`. Supported formats and the maximum document size are under "Source Configuration"; "Deploy Behavior" is merged into "Sync".
