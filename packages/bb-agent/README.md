# @aws-blocks/bb-agent

AI agent with streaming, tool calling, and conversation persistence. Powered by [Strands Agents SDK](https://strandsagents.com/).

**When to use:** Conversational AI experiences — chatbots, copilots, data extraction, or any LLM-powered feature. Supports multi-turn conversations, tool calling with Zod schemas, and multiple model providers.

**Requires:** `zod` ^4.0.0 as a peer dependency. Tool parameters use Zod schemas for validation. If you see `ZodType missing properties` errors, check your zod version.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick Start

```typescript
import { Scope } from '@aws-blocks/core';
import { Agent } from '@aws-blocks/bb-agent';

const scope = new Scope('my-app');

const agent = new Agent(scope, 'support-agent', {
  systemPrompt: 'You are a helpful support agent.',
});

// Create a conversation and stream a response — iterate the chunks as they arrive
const conversationId = await agent.createConversationId('user-123');
let answer = '';
for await (const chunk of agent.streamSSE('Until when are you open tomorrow?', { conversationId, userId: 'user-123' })) {
  if (chunk.type === 'text-delta') answer += chunk.text;   // stream tokens as they arrive
  if (chunk.type === 'done') console.log(answer);          // "We're open until 6pm tomorrow."
}
```
Uses [`BedrockModels.BALANCED`](#bedrock-presets) (Claude Sonnet 4.6) by default. See [Model Configuration](#model-configuration) for other presets, [Tools](#tools) for adding capabilities, and [Local Development](#local-development) for running without AWS Bedrock.

## API

```typescript
const agent = new Agent(scope, id, config)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `streamSSE(message, options?)` | `AsyncGenerator<AgentStreamChunk>` | **Primary API.** Run a turn and yield chunks as they arrive. Iterate with `for await`. |
| `createConversationId(userId)` | `Promise<string>` | Generate a new conversation ID (UUID). |
| `getConversation(id, options?)` | `Promise<Message[]>` | Get messages in a conversation. Pass `{ limit }` for most recent N. |
| `listConversations(userId)` | `Promise<Conversation[]>` | List all conversations for a user. |
| `deleteConversation(id, userId)` | `Promise<void>` | Delete a conversation and its session data. |
| `getPendingInterrupts(conversationId)` | `Promise<Array<...>>` | Get unanswered interrupts (for reload support). |
| `stream(message, options?)` | `AgentStreamResult` | **@deprecated** — compatibility wrapper over `streamSSE()`. Returns an async-iterable with a `complete()` helper. |
| `resume(responses, options?)` | `AgentStreamResult` | **@deprecated** — resume an interrupted agent. Prefer `streamSSE('', { interruptResponses })`. |

`streamSSE()` runs a turn and yields `AgentStreamChunk`s (text deltas, tool calls, interrupts, and a terminal `done`) as they are produced — iterate it with `for await`. To resume after a human-in-the-loop approval, pass `interruptResponses` instead of a `message`.

**Where the loop runs matters on AWS.** Calling `streamSSE()` directly runs the agent loop *in the current process*. In a Lambda-backed RPC handler that means a long turn is still bounded by the API-Gateway ~29s cap — fine for **local dev, headless scripts, and short turns**, but not for long-running/streaming agents. For the **browser** on AWS, use the [`useChat` hook](#client-hook--usechat) with `createAgentCoreWsTransport`: the loop runs inside the AgentCore Runtime and streams over a WebSocket, escaping the Lambda/API-Gateway limits. (The runtime drives the same `streamSSE()` internally — you don't call it from the browser.)

> **Migrating from the Realtime/AsyncJob API?** `getChannel()` and `channel.subscribe()` are **removed** — iterate `streamSSE()` directly, or on the browser use [`useChat`](#client-hook--usechat). `stream()` and `resume()` still work but are **deprecated** wrappers over `streamSSE()`; note `resume()` **dropped its leading `channelId` argument**: `resume(channelId, responses, …)` → `resume(responses, { conversationId })`.

### Authorization (caller responsibility)

The Agent BB scopes data by `conversationId`, which is an unguessable UUID, but it does **not** authorize the caller against a conversation on read paths. `getConversation(id)` and `getPendingInterrupts(conversationId)` take only an id, so any caller that supplies a valid conversation ID gets the messages back.

Your API handler owns authorization: derive `userId` from the authenticated session and verify the conversation belongs to that user before reading it. `listConversations(userId)` returns only the conversations a user owns, so it's the safe way to resolve which conversation IDs a caller may access:

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getMessages(conversationId: string) {
    const user = await auth.getCurrentUser(context);
    const owned = await agent.listConversations(user.userId);
    if (!owned.some(c => c.conversationId === conversationId)) {
      throw new Error('Not found');
    }
    return agent.getConversation(conversationId);
  },
}));
```

`deleteConversation(id, userId)` is owner-scoped internally — it verifies the conversation belongs to `userId` before deleting anything, so a non-owner call is a no-op.

### AgentStreamResult

Returned by the deprecated `stream()` / `resume()` wrappers. It's an async-iterable of `AgentStreamChunk` (iterate with `for await`) with one convenience method:

| Property/Method | Type | Description |
|--------|------|-------------|
| `complete()` | `Promise<AgentStreamChunk>` | Drain the stream and resolve with the terminal `done` chunk (full text + token usage). Rejects on `error`; throws `InterruptError` on `interrupt`. |

New code should iterate `streamSSE()` directly instead.

### AgentStreamChunk

Each chunk yielded by `streamSSE()` has a `type` and type-specific fields:

| Type | Fields | Description |
|------|--------|-------------|
| `text-delta` | `text: string` | Incremental text token (in `'token'` streaming mode) or full block (in `'block'` mode). |
| `tool-call` | `toolName: string`, `input: JSONValue` | Agent is calling a tool. |
| `tool-result` | `toolName: string` | Tool returned a result. Read the tool output from conversation history if you need it. |
| `done` | `text: string`, `usage: TokenUsage` | Agent finished. `text` contains the full response. `usage` has `{ inputTokens, outputTokens, totalTokens }`. |
| `error` | `error: string` | Agent encountered an error. |
| `interrupt` | `interrupts: Array<{ id, name, reason }>` | Agent paused for approval. See [Tool Approval](#tool-approval-human-in-the-loop). |

### Message Roles

Messages stored in conversation history use these roles:

| Role | Description |
|------|-------------|
| `user` | User message. |
| `assistant` | Agent response text. |
| `tool-call` | Record of a tool invocation (stored for audit). |
| `tool-result` | Record of a tool's return value. |
| `approval` | User's approval/denial response to an interrupt. |
| `interrupt` | Agent paused — snapshot of pending interrupts. |

The `useChat` hook only surfaces `user`, `assistant`, and `approval` messages to the UI. Use `agent.getConversation()` directly to access the full history including tool-call/tool-result records.

### AgentConfig

| Option | Type | Description |
|--------|------|----------------------------------------------------------------------|
| `model` | `{ deployed, local? }` | Model configuration (see below). |
| `systemPrompt` | `string` | System prompt for the agent. |
| `tools` | `(tool) => Record<string, AgentTool>` | Tools the agent can call during reasoning. |
| `toolContextSchema` | `z.ZodType` | Optional schema for per-call tool context. When set, `context` is required and typed. |
| `inferenceOnly` | `boolean` | Skip persistence infra. Default: `false`. |
| `conversation` | `ConversationManagerConfig` | How the agent trims message history (sliding-window or summarizing). |
| `streamingMode` | `'token' \| 'block'` | How text chunks are published to the client. Default: `'block'`. |

### Model Configuration

Model configuration is optional. When omitted, the agent defaults to `BedrockModels.BALANCED` (Claude Sonnet 4.6) for deployment. Local development works out of the box — the canned provider (keyword-based mock) is used automatically when no local model is specified.

| Option | Type | Description |
|--------|------|-------------|
| `provider` | `'bedrock' \| 'openai-api' \| 'canned'` | Model provider. |
| `modelId` | `string` | Model ID. Required for bedrock and openai-api. |
| `endpoint` | `string` | API endpoint. For openai-api (defaults to api.openai.com). |
| `apiKey` | `string \| () => Promise<string>` | API key for openai-api. Accepts a string or async resolver. Falls back to `OPENAI_API_KEY` env var. |
| `inferenceConfig` | `{ temperature?, topP?, maxTokens?, stopSequences? }` | Optional inference parameters. |

```typescript
import { Agent } from '@aws-blocks/bb-agent';

// Minimal — just deployed model, canned provider used locally automatically
const agent = new Agent(scope, 'agent', {
  model: {
    deployed: { provider: 'bedrock', modelId: '...' },
  },
  systemPrompt: '...',
});
```

Specify a model for local development to use instead of the canned provider:

```typescript
const agent = new Agent(scope, 'agent', {
  model: {
    deployed: { provider: 'bedrock', modelId: '...' },
    local: { provider: 'openai-api', modelId: 'llama3.1:8b', endpoint: 'http://localhost:11434/v1', apiKey: 'ollama' },
  },
  systemPrompt: '...',
});
```

For fallback support, provide an array of candidates. They are tried in order — the first available model wins. Health checks verify each candidate before selecting it (see [Health Checks](#health-checks)):

```typescript
model: {
  deployed: [
    { provider: 'bedrock', modelId: '...' },
    { provider: 'bedrock', modelId: '...' },
    { provider: 'canned' },  // canned can be used in deployed as a last resort
  ],
  local: [
    { provider: 'openai-api', modelId: 'llama3.2:3b', endpoint: 'http://localhost:11434/v1' },
    // canned is always appended implicitly as last fallback for local
  ],
}
```

#### Bedrock Presets

Pre-configured model presets for quick setup. Names are capability-based so the underlying model can be upgraded without breaking your code. These use [global inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html) — requests may be routed to any supported AWS region for optimal throughput. If your workload has data residency requirements, specify a region-scoped inference profile explicitly instead of using a preset.

```typescript
import { Agent, BedrockModels} from '@aws-blocks/bb-agent';

const agent = new Agent(scope, 'agent', {
  model: {
    deployed: BedrockModels.BALANCED,
  },
  systemPrompt: '...',
});
```

| Preset | Current Model | Notes |
|--------|---------------|-------|
| `BedrockModels.BALANCED` | `global.anthropic.claude-sonnet-4-6` | Great tool use, balanced cost. Recommended default for most workloads. |
| `BedrockModels.SMART` | `global.anthropic.claude-opus-4-8` | Highest capability for the hardest tasks. |
| `BedrockModels.FAST` | `global.anthropic.claude-haiku-4-5-20251001-v1:0` | Lowest latency, still strong capabilities. |

> **Migrating?** `DEFAULT` → `BALANCED` (or `SMART` for highest capability). `BUDGET`/`MICRO` → `FAST`. The old presets are still available but deprecated. Please consider upgrading!

Override inference settings with spread:
```typescript
model: { deployed: { ...BedrockModels.BALANCED, inferenceConfig: { temperature: 0.9, maxTokens: 8192 } } }
```

#### Ollama Presets

Convenience shortcuts for local development using [Ollama](https://ollama.com/). Requires Ollama installed and running (`ollama serve`), model pulled (`ollama pull <model-id>`). Uses the default endpoint `http://localhost:11434/v1`.

```typescript
import { Agent, BedrockModels, OllamaModels} from '@aws-blocks/bb-agent';

const agent = new Agent(scope, 'agent', {
  model: {
    deployed: BedrockModels.BALANCED, 
    local: OllamaModels.SMALL,
  },
  systemPrompt: '...',
});
```

| Preset | Current Model | Size | Recommended VRAM |
|--------|---------------|------|------------------|
| `OllamaModels.XSMALL` | `llama3.2:3b` | 2 GB | 4 GB |
| `OllamaModels.SMALL` | `llama3.1:8b` | 4.7 GB | 8 GB |
| `OllamaModels.MEDIUM` | `deepseek-r1:14b` | 9 GB | 16 GB |
| `OllamaModels.LARGE` | `llama3.3:70b` | 43 GB | 48 GB+ |
| `OllamaModels.XLARGE` | `llama4:16x17b` | 67 GB | 80 GB+ |

Custom endpoint or specific model? Use `openai-api` directly:
```typescript
model: { local: { provider: 'openai-api', modelId: 'llama3.1:8b', endpoint: 'http://custom-host:11434/v1', apiKey: 'ollama' } }
```
See [Ollama Presets](#ollama-presets) and [Local Development](#local-development) for more options.

#### Health Checks

Before selecting a model, the agent verifies its availability:

- **Bedrock:** Verifies model availability via `@aws-sdk/client-bedrock` (free, no inference cost).
- **OpenAI-compatible:** Pings `GET /v1/models` and checks if the specified model ID is in the response.
- **Canned:** Always available (no external dependency).

Health checks verify the model *exists* but cannot guarantee invoke access (e.g., EULA not accepted, quota limits). If all candidates fail, the agent throws `AgentErrors.ModelUnavailable`. Check logs for details.

To see detailed health check logs, pass a logger with `info` level:

```typescript
import { Logger } from '@aws-blocks/bb-logger';

const agent = new Agent(scope, 'agent', {
  model: { deployed: BedrockModels.BALANCED },
  systemPrompt: '...',
  logger: new Logger(scope, 'agent-log', { level: 'info' }),
});
```

#### API Key Management

```typescript
// Recommended: AppSetting with secret (encrypted via SSM SecureString)
const openaiKey = new AppSetting(scope, 'openai-key', {
  name: '/myapp/openai-api-key',
  secret: true,
});

const agent = new Agent(scope, 'agent', {
  model: {
    deployed: {
      provider: 'openai-api',
      modelId: 'gpt-4',
      apiKey: () => openaiKey.get(),
    },
  },
});

// Alternative: environment variable (local dev)
// Set OPENAI_API_KEY — no apiKey needed in config

// Alternative: plain string (discouraged — leaks in source control)
// apiKey: 'sk-...'
```

#### AWS Credentials (Bedrock)

The `bedrock` provider uses your configured AWS credentials. See [Strands quickstart](https://strandsagents.com/docs/user-guide/quickstart/typescript/#configuring-credentials) for setup instructions.

#### Bedrock via Mantle

Amazon Bedrock exposes an OpenAI-compatible endpoint via [Bedrock Mantle](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html). Use it with `provider: 'openai-api'` and set the endpoint to `https://bedrock-mantle.<region>.api.aws/v1`.

### Error Handling

```typescript
import { isBlocksError } from '@aws-blocks/core';
import { AgentErrors } from '@aws-blocks/bb-agent';

try {
  await agent.getConversation(id);
} catch (e: unknown) {
  if (isBlocksError(e, AgentErrors.PersistenceRequired)) {
    // agent is in inferenceOnly mode
  }
}
```

| Error | When |
|-------|------|
| `AgentErrors.PersistenceRequired` | Conversation CRUD called on an inferenceOnly agent. |
| `AgentErrors.InvalidModelConfig` | Missing modelId, apiKey, unknown provider, or `needsApproval` + `interrupt` both specified. |
| `AgentErrors.ModelUnavailable` | All model candidates failed health checks. Check logs for details. |
| `AgentErrors.StreamFailed` | Agent encountered an error during execution. |
| `AgentErrors.InterruptRequired` | Agent paused for approval. Use `InterruptError` for typed access to pending interrupts. |
| `AgentErrors.BrowserNotSupported` | Agent instantiated in the browser (server-side only). |

### Streaming Mode

Controls how text is published to the client:

- **`'block'` (default)** — buffers text and publishes when a full content block completes.
- **`'token'`** — publishes every text delta immediately as it arrives. Use for typewriter-style UIs.

```typescript
const agent = new Agent(scope, 'support', {
  streamingMode: 'token',
  ...
});
```

### Conversation Management

Controls how the agent trims message history when the context window fills up:

```typescript
// Sliding window — keep last 20 messages
const agent = new Agent(scope, 'support', {
  conversation: { strategy: 'sliding-window', windowSize: 20 },
  ...
});

// Summarizing — summarizes older messages, preserves 5 most recent
const agent = new Agent(scope, 'support', {
  conversation: { strategy: 'summarizing', preserveRecentMessages: 5 },
  ...
});
```

## Tools

Tools let the agent take actions during its reasoning — query a database, call an API, send an email. The model decides *when* to call a tool based on the user's message and the tool's description. You define the tool's schema and handler; the framework handles the rest.

### Adding Tools

Add tools to let the agent take actions. Each tool has a description, Zod schema for parameters, and a handler. The handler receives `{ input, context, interrupt }`:

```typescript
import { z } from 'zod';

const agent = new Agent(scope, 'support', {
  model: { deployed: { provider: 'bedrock', modelId: '...' } },
  systemPrompt: 'You are a customer support agent. Look up orders when asked.',
  tools: (tool) => ({
    getOrderStatus: tool({
      description: 'Get the status of a customer order by ID',
      parameters: z.object({ orderId: z.string() }),
      handler: async ({ input }) => {
        const order = await db.getOrder(input.orderId);
        return { orderId: input.orderId, status: order.status, total: order.total };
      },
    }),
  }),
});
```

### Declaring tools (the `tools` callback)

`tools` is a callback that receives a `tool()` factory and returns a Record keyed by tool name:

```typescript
tools: (tool) => ({
  getOrderStatus: tool({ /* ... */ }),
})
```

The callback form lets TypeScript infer each tool's `input` from its `parameters`. The Record key is the tool's name.

### Tool Context — Scoping Tools to the Caller

Tools often need request-scoped information (e.g. the authenticated `userId`). Pass a `context` object on each `streamSSE()` call; it's forwarded to every tool invocation:

```typescript
const agent = new Agent(scope, 'support', {
  model: { deployed: { provider: 'bedrock', modelId: '...' } },
  systemPrompt: 'You are a support agent.',
  tools: (tool) => ({
    listMyOrders: tool({
      description: "List the current user's orders",
      parameters: z.object({}),
      handler: async ({ context }) => {
        return db.listOrders({ userId: context.userId });
      },
    }),
  }),
});

const user = await auth.getCurrentUser(requestContext);
for await (const _ of agent.streamSSE(message, { conversationId, userId: user.userId, context: { userId: user.userId } })) {
  // consume chunks (or forward them to the client)
}
```

To make context required and type-safe, declare a `toolContextSchema`:

```typescript
const agent = new Agent(scope, 'support', {
  model: { deployed: { provider: 'bedrock', modelId: '...' } },
  systemPrompt: '...',
  toolContextSchema: z.object({ userId: z.string(), tenantId: z.string() }),
  tools: (tool) => ({
    listMyOrders: tool({
      description: "List the current user's orders",
      parameters: z.object({}),
      handler: async ({ context }) => {
        // context.userId and context.tenantId are typed as string
        return db.listOrders({ userId: context.userId, tenantId: context.tenantId });
      },
    }),
  }),
});

// context is now required and validated — omitting it throws InvalidModelConfig
for await (const _ of agent.streamSSE(message, { conversationId, userId, context: { userId, tenantId } })) {
  // consume chunks
}
```

### Using KnowledgeBase with the Agent

The `KnowledgeBase` BB can be used as an agent tool, giving the agent the ability to search documents on demand:

```typescript
import { Agent } from '@aws-blocks/bb-agent';
import { KnowledgeBase } from '@aws-blocks/bb-knowledge-base';
import { z } from 'zod';

const kb = new KnowledgeBase(scope, 'docs', {
  source: './knowledge',
  description: 'Product documentation and FAQs',
});

const agent = new Agent(scope, 'assistant', {
  model: { deployed: { provider: 'bedrock', modelId: '...' } },
  systemPrompt: 'You are a helpful assistant. Search the knowledge base when the user asks about our product.',
  tools: (tool) => ({
    searchDocs: tool({
      description: 'Search product documentation for relevant information',
      parameters: z.object({
        query: z.string().describe('The search query'),
        maxResults: z.number().optional().describe('Max results to return (default: 5)'),
      }),
      handler: async ({ input }) => kb.retrieve(input.query, { maxResults: input.maxResults ?? 5 }),
    }),
  }),
});
```

### Tool Approval (Human-in-the-Loop)

By default, tools run autonomously. Set `needsApproval: true` on tools that should pause for user approval — the agent publishes an interrupt chunk, the client shows a confirmation UI, the user responds, and the agent resumes.

| Configuration | Behavior |
|---------------|----------|
| `needsApproval: false` (default) | Tool runs autonomously |
| `needsApproval: true` | Pauses for approval every time — user sees Yes / No |
| `needsApproval: true, trustable: true` | Pauses for approval — user sees Yes / No / Trust. "Trust" auto-approves for the rest of the conversation |

Tools that modify state should require user approval. Set `needsApproval: true`:

```typescript
tools: (tool) => ({
  getOrderStatus: tool({
    description: 'Look up an order',
    parameters: z.object({ orderId: z.string() }),
    needsApproval: false,  // read-only — safe to run
    handler: async ({ input }) => db.getOrder(input.orderId),
  }),
  cancelOrder: tool({
    description: 'Cancel a customer order',
    parameters: z.object({ orderId: z.string(), reason: z.string() }),
    needsApproval: true,   // destructive — ask first
    trustable: true,        // user can say "trust" to stop being asked
    handler: async ({ input }) => db.cancelOrder(input.orderId, input.reason),
  }),
})
```
When a tool is interrupted, the stream yields an `interrupt` chunk. Resume by streaming a new turn with `interruptResponses` and an empty `message`:

```typescript
// Stream yielded: { type: 'interrupt', interrupts: [{ id, name, reason }] }
// User approves → resume the agent on the same conversation:
for await (const chunk of agent.streamSSE('', {
  conversationId,
  userId,
  interruptResponses: [{ interruptId: interrupt.id, response: 'yes' }], // 'yes' | 'no' | 'trust'
})) {
  // handle resumed chunks
}
```

**Interrupt chunk format:** `name` is `approve:${toolName}:${toolUseId}` and `reason` contains `{ tool: string, input: any, trustable: boolean }`. Use `reason.tool` for display and `reason.trustable` to decide whether to show a Trust button.

### Custom Interrupts

For tools that need input-level approval decisions or runtime-conditional pausing, use the `interrupt` field or call `interrupt()` inside the handler:

```typescript
tools: (tool) => ({
  transferMoney: tool({
    description: 'Transfer money between accounts',
    parameters: z.object({ from: z.string(), to: z.string(), amount: z.number() }),
    interrupt: ({ input, interrupt }) => {
      if (input.amount > 100) {
        interrupt({ name: 'confirm-transfer', reason: { message: `Transfer $${input.amount}?` } });
      }
    },
    handler: async ({ input }) => ({ status: 'completed', amount: input.amount }),
  }),
})
```

## Headless Usage (No UI)

The Agent BB works without a frontend — for scripts, background jobs, or server-to-server flows. Iterate `streamSSE()` and read the terminal `done` chunk for the full response. For UI-based flows, see [Client Hook — useChat](#client-hook--usechat).

### Without tool approval

```typescript
import { Agent, BedrockModels } from '@aws-blocks/bb-agent';

const agent = new Agent(scope, 'summarizer', {
  model: { deployed: BedrockModels.BALANCED },
  systemPrompt: 'Summarize the input concisely.',
});

const conversationId = await agent.createConversationId('system');
for await (const chunk of agent.streamSSE('Summarize this quarter earnings report...', { conversationId, userId: 'system' })) {
  if (chunk.type === 'done') console.log(chunk.text);
}
```

### With tool approval

When a tool has `needsApproval: true`, the stream yields an `interrupt` chunk instead of finishing. Answer the interrupts, then resume by streaming again with `interruptResponses`:

```typescript
import { Agent, BedrockModels } from '@aws-blocks/bb-agent';
import { z } from 'zod';

const refundBot = new Agent(scope, 'refunds', {
  model: { deployed: BedrockModels.BALANCED },
  systemPrompt: 'You process customer refund requests.',
  tools: (tool) => ({
    issueRefund: tool({
      description: 'Issue a refund to a customer',
      parameters: z.object({ orderId: z.string(), amount: z.number() }),
      needsApproval: true,
      handler: async ({ input }) => {
        await payments.refund(input.orderId, input.amount);
        return { refunded: true, amount: input.amount };
      },
    }),
  }),
});

const conversationId = await refundBot.createConversationId('system');

let message = 'Refund order #456, item was damaged. Total was $75.';
let interruptResponses: Array<{ interruptId: string; response: string }> | undefined;

while (true) {
  let pending: Array<{ id: string; reason?: any }> | undefined;
  for await (const chunk of refundBot.streamSSE(message, { conversationId, userId: 'system', interruptResponses })) {
    if (chunk.type === 'done') console.log(chunk.text);
    if (chunk.type === 'interrupt') pending = chunk.interrupts;
  }
  if (!pending) break; // finished with no interrupt

  // Auto-approve refunds under $100, reject larger ones. Resume with an empty message.
  message = '';
  interruptResponses = pending.map((i) => ({
    interruptId: i.id,
    response: i.reason?.input?.amount < 100 ? 'yes' : 'no',
  }));
}
```

## Inference-Only (No Persistence)

Set `inferenceOnly: true` for stateless tasks that don't need conversation history — classification, extraction, summarization. No DynamoDB tables or session storage are created.

```typescript
const classifier = new Agent(scope, 'classifier', {
  inferenceOnly: true,
  model: { deployed: { provider: 'bedrock', modelId: '...' } },
  systemPrompt: 'Classify the sentiment of the input as positive, negative, or neutral.',
});

for await (const chunk of classifier.streamSSE('I love this product!')) {
  if (chunk.type === 'done') console.log(chunk.text); // "positive"
}
```
## Local Development

The Agent BB works locally without any external dependencies. No AWS credentials, no API keys, no running services — just `npm run dev`.
By default the agent uses the **CannedProvider** — a keyword-based mock that responds instantly without calling any real model. For real LLM calls locally, set `model.local` to an `openai-api` config (Ollama, vLLM, etc.) or use the Ollama presets. See [Model Configuration](#model-configuration) for details.

### Use Local LLM

For real model responses during development, use a fallback chain with your company's shared vLLM server and a local Ollama instance. The agent tries each in order — on the company network it uses the shared server, at home it falls through to your local Ollama:

```typescript
const agent = new Agent(scope, 'support', {
  model: {
    deployed: { provider: 'bedrock', modelId: '...' },
    local: [
      { provider: 'openai-api', modelId: 'llama3.1:70b', endpoint: 'http://vllm.internal.company.com/v1' },
      { provider: 'openai-api', modelId: 'llama3.1:8b', endpoint: 'http://localhost:11434/v1', apiKey: 'ollama' },
      // canned is appended implicitly — if nothing is available, agent still works
    ],
  },
  systemPrompt: '...',
});
```

### Canned Provider

The CannedProvider is a custom Strands model provider that requires no network or API keys:

- Returns simple mock responses
- Triggers tool calls when the prompt mentions a tool name (e.g., "get order" triggers `getOrderStatus`)
- Generates valid tool inputs from Zod schemas using type-based placeholders
- Streams responses word by word, matching the same protocol as real providers


## Client Hook — `useChat`

Import from `@aws-blocks/bb-agent/client`. Manages conversation state, streaming, and interrupt handling. You give it two things: an `api` object with a few conversation methods, and a **`streamChunks`** function that yields the chunks for a turn.

```typescript
import { useChat, createAgentCoreWsTransport } from '@aws-blocks/bb-agent/client';

const chat = useChat({
  api: {
    createConversation: () => api.createConversation(),
    getConversation: (id) => api.getConversation(id),
    getPendingInterrupts: (id) => api.getPendingInterrupts(id), // optional — for reload support
  },
  // Where the chunks come from. On AWS, stream directly from the AgentCore Runtime over a
  // WebSocket — the transport fetches the endpoint + token from your backend, opens the socket,
  // and yields chunks. See "Full Examples" below for the backend method it calls.
  streamChunks: createAgentCoreWsTransport((args) => api.getStreamEndpoint(args.conversationId)),
  onMessagesChange: (msgs) => renderMessages(msgs),
  onLoadingChange: (loading) => updateSpinner(loading),
  onInterrupt: (interrupts) => showApprovalUI(interrupts),
});

await chat.sendMessage('Hello!');
await chat.respondToInterrupt([{ interruptId: 'x', approved: true }]);
```

`streamChunks` is the single seam that decides *how* chunks are delivered. Use `createAgentCoreWsTransport` for the browser-direct WebSocket path on AWS, or supply your own async generator (e.g. wrapping a buffered RPC) for local/simple cases — `useChat` doesn't care which.

**Note:** `useChat` is a factory function, not a React hook. Call it **once** (e.g., outside a component or in a ref) — not on every render. It returns a mutable singleton. Message history only includes `user`, `assistant`, and `approval` messages — tool-call/tool-result internals are filtered for UI clarity. Use `getConversation()` directly if you need the full history.

## Full Examples

### 1. End-to-End: Backend + Frontend with `useChat`

Complete wiring showing the backend API and frontend `useChat` connected together.

**Backend** (`aws-blocks/index.ts`):

```typescript
import { Scope, ApiNamespace } from '@aws-blocks/core';
import { Agent, BedrockModels } from '@aws-blocks/bb-agent';
import { AuthCognito } from '@aws-blocks/bb-auth-cognito';

const scope = new Scope('my-app');

const auth = new AuthCognito(scope, 'auth', { /* pool config */ });

const agent = new Agent(scope, 'chat', {
  auth,                                     // gives the runtime a JWT authorizer
  model: { deployed: BedrockModels.BALANCED },
  systemPrompt: 'You are a helpful assistant.',
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async createConversation() {
    const user = await auth.requireAuth(context);
    return { conversationId: await agent.createConversationId(user.userId) };
  },
  // Verify ownership before reading — getConversation/getPendingInterrupts take only an id
  // and don't authorize the caller (see "Authorization (caller responsibility)" above).
  async getConversation(conversationId: string) {
    const user = await auth.requireAuth(context);
    const owned = await agent.listConversations(user.userId);
    if (!owned.some((c) => c.conversationId === conversationId)) throw new Error('Not found');
    return { messages: await agent.getConversation(conversationId) };
  },
  async getPendingInterrupts(conversationId: string) {
    const user = await auth.requireAuth(context);
    const owned = await agent.listConversations(user.userId);
    if (!owned.some((c) => c.conversationId === conversationId)) throw new Error('Not found');
    return { interrupts: await agent.getPendingInterrupts(conversationId) };
  },
  // The browser calls this to learn where to stream. It pairs the Agent's endpoint with a
  // short-lived JWT from the auth BB. userId comes from the authenticated session, not the
  // client, so a caller can't stream as someone else. Note: on the JWT/WebSocket path the
  // runtime derives the persistence userId from the validated token `sub`, so this value is a
  // fallback used only on IAM runtimes (see DESIGN.md "Canonical persistence identity").
  async getStreamEndpoint(conversationId?: string) {
    const user = await auth.requireAuth(context);
    const endpoint = await agent.getStreamEndpoint({ conversationId });
    const token = await auth.getAgentCoreToken(context);
    return { ...endpoint.toJSON(), token, userId: user.userId };
  },
}));
```

**Frontend** (`app.ts`):

```typescript
import { useChat, createAgentCoreWsTransport } from '@aws-blocks/bb-agent/client';

const chat = useChat({
  api: {
    createConversation: () => api.createConversation(),
    getConversation: (id) => api.getConversation(id),
    getPendingInterrupts: (id) => api.getPendingInterrupts(id),
  },
  // Opens a WebSocket straight to the AgentCore Runtime and yields chunks as they arrive.
  streamChunks: createAgentCoreWsTransport(({ conversationId }) => api.getStreamEndpoint(conversationId)),
  onMessagesChange: (msgs) => renderMessages(msgs),
  onLoadingChange: (loading) => updateSpinner(loading),
});

// Send a message — chunks stream in via onMessagesChange
await chat.sendMessage('Hello!');

// Load an existing conversation (backfills history, surfaces any pending interrupt)
await chat.loadConversation('conv-123');
```

### 2. Support Agent with Tools

Agent with tools that can look up orders and search documentation. Uses tool context to scope queries to the authenticated user.

```typescript
import { Scope, ApiNamespace } from '@aws-blocks/core';
import { Agent, BedrockModels } from '@aws-blocks/bb-agent';
import { KnowledgeBase } from '@aws-blocks/bb-knowledge-base';
import { z } from 'zod';

const scope = new Scope('my-app');

const kb = new KnowledgeBase(scope, 'docs', { source: './knowledge' });

const agent = new Agent(scope, 'support', {
  model: { deployed: BedrockModels.BALANCED },
  systemPrompt: 'You are a customer support agent. Look up orders and search documentation to help the user.',
  toolContextSchema: z.object({ userId: z.string() }),
  tools: (tool) => ({
    getOrder: tool({
      description: 'Get order details by ID',
      parameters: z.object({ orderId: z.string() }),
      handler: async ({ input, context }) => {
        return db.getOrder(input.orderId, { userId: context.userId });
      },
    }),
    searchDocs: tool({
      description: 'Search product documentation',
      parameters: z.object({ query: z.string() }),
      handler: async ({ input }) => kb.retrieve(input.query, { maxResults: 5 }),
    }),
  }),
});
```

Wire it to a frontend exactly like [Example 1](#1-end-to-end-backend--frontend-with-usechat) — the browser streams over a WebSocket and `useChat` handles interrupts. This agent declares a `toolContextSchema`, so its tools require a per-call `context`. You don't pass that from the browser (it couldn't be trusted anyway): **on a JWT runtime the server injects the authenticated `userId` (the validated token's `sub`) into tool `context`**, so `getOrder` is scoped to the caller with an unforgeable identity.

**Backend** (`amplify/backend.ts`) — same shape as Example 1; `getStreamEndpoint` pairs the runtime endpoint with a short-lived JWT:

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async createConversation() {
    const user = await auth.requireAuth(context);
    return { conversationId: await agent.createConversationId(user.userId) };
  },
  async getConversation(conversationId: string) {
    const user = await auth.requireAuth(context);
    const owned = await agent.listConversations(user.userId);
    if (!owned.some((c) => c.conversationId === conversationId)) throw new Error('Not found');
    return { messages: await agent.getConversation(conversationId) };
  },
  async getPendingInterrupts(conversationId: string) {
    const user = await auth.requireAuth(context);
    const owned = await agent.listConversations(user.userId);
    if (!owned.some((c) => c.conversationId === conversationId)) throw new Error('Not found');
    return { interrupts: await agent.getPendingInterrupts(conversationId) };
  },
  async getStreamEndpoint(conversationId?: string) {
    await auth.requireAuth(context);
    const endpoint = await agent.getStreamEndpoint({ conversationId });
    const token = await auth.getAgentCoreToken(context);
    return { ...endpoint.toJSON(), token };
  },
}));
```

**Frontend** (`app.ts`):

```typescript
import { useChat, createAgentCoreWsTransport } from '@aws-blocks/bb-agent/client';

const chat = useChat({
  api: {
    createConversation: () => api.createConversation(),
    getConversation: (id) => api.getConversation(id),
    getPendingInterrupts: (id) => api.getPendingInterrupts(id),
  },
  // Opens a WebSocket straight to the AgentCore Runtime. The tool `context` is filled in
  // server-side from the verified token — the browser sends no identity.
  streamChunks: createAgentCoreWsTransport(({ conversationId }) => api.getStreamEndpoint(conversationId)),
  onMessagesChange: (msgs) => renderMessages(msgs),
});

await chat.sendMessage('What is the status of order 12345?');
```

> Tool `context` on the browser-direct path is limited to what the server derives from the verified token — currently `userId` (the `sub`). An agent that needs richer per-call context should stream through a server-mediated API method that builds `context` itself.


## Best Practices

- Keep system prompts focused — one agent per task, not one agent for everything
- Define tools with descriptive names and descriptions — the model uses these to decide when to call them
- Set `model.local` to an array of fallback candidates for flexible local dev
- Set logging to `info` during development to surface health check and model resolution details

## What It Provisions

The Agent BB provisions the following on AWS — the AgentCore Runtime plus two internal Building Blocks:

| Component | AWS Resource | Purpose |
|-----------|-------------|---------|
| AgentCore Runtime | Bedrock AgentCore | Hosts and runs the agent; streams to the browser directly |
| `FileBucket` (BB) | S3 | Session snapshot storage (agent state between turns) |
| `DistributedTable` × 2 (BB) | DynamoDB | Conversations table + messages table |

When `inferenceOnly: true`, the two DistributedTables are skipped (no conversation persistence).

## Scaling & Cost (AWS)

- **Agent runtime:** Bedrock AgentCore — billed for active compute while a turn runs; sessions can stay warm and live up to 8 hours (no 15-minute Lambda ceiling). See [AgentCore pricing](https://aws.amazon.com/bedrock/pricing/).
- **Model:** Bedrock pay-per-token pricing. See [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/).
- **Persistence:** DynamoDB (DistributedTable) — PAY_PER_REQUEST, single-digit ms latency.
- **Session storage:** S3 (FileBucket) — ~$0.023 per GB/month.

## Troubleshooting

**"Access denied / Legacy model"** — Some older model IDs may be marked as legacy. Switch to a cross-region inference profile.

**"ValidationException"** — Model ID not recognized. Use `aws bedrock list-foundation-models --query "modelSummaries[].modelId"` to see available models.

**Health check passes but invocation fails** — The health check verifies the model exists but cannot check EULA acceptance or account-level access.

## See Also

- [Strands Agents SDK](https://strandsagents.com/)
- [Bedrock supported models](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html)
- [Cross-region inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)
- [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)
- [Ollama model library](https://ollama.com/library)
