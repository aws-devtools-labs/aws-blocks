# Task: Knowledge-Base Chat Agent with Tool Use

Build a chat assistant in this AWS Blocks app. A user types a question; an AI **agent** answers it. The agent must be able to (a) look facts up in a **knowledge base** you seed from a local folder of documents, and (b) call at least one **tool** to take an action. Each answer is shown as a chat bubble, the questions and answers accumulate in a message list, and when the agent uses a tool or cites a document the UI shows that.

## Setup (do this first)

The workspace has already been scaffolded and the dev server is running; its port is in `/tmp/dev.port`. Begin by reading `README.md` and `AGENTS.md`, then do all your edits in this workspace.

This is the `demo` template — a vanilla TypeScript + Vite frontend (`index.html` + `src/index.ts`) on port 3000, with the backend wired in `aws-blocks/index.ts`. The frontend imports the backend with `import { api } from 'aws-blocks'`; you call typed methods on it and the JSON-RPC transport is invisible. Replace the template's placeholder demo (todos / KV / cookies) with your chat UI.

## Requirements

### Knowledge base (seed it yourself)
1. **Create a `knowledge/` folder** containing **at least one `.md` document**, and point a knowledge-base block at it (`source: './knowledge'`). Locally the block indexes the folder with a TF-IDF stub and answers `retrieve()` queries; in the cloud it is backed by Bedrock.
2. **Required seed content.** One document must be a short Nimbus-7 product sheet that records, in a single passage, **all** of:
   - the product's internal product code **`QUOKKA-9F42`**,
   - its maximum hover altitude of **`1337 centimeters`**,
   - the word **`sample`** (the local index is probed with a generic term, and the grader relies on this word being in the same passage as the facts above).

   These three facts must appear **only** in the knowledge base — nowhere in your frontend or backend source — so that an answer repeating them proves a real retrieval happened. The same (or another) document must also describe the **return / refund policy** and contain the word **`refund`**. Write real prose, not a stub. Set the block's chunking to `{ strategy: 'none' }` so the passage stays in one chunk.

### Agent + tools
3. Wire an **agent block** whose deployed model is Amazon Bedrock with the Claude Sonnet 4.6 inference profile — model id exactly **`us.anthropic.claude-sonnet-4-6`**. (Locally a keyword-driven mock stands in for Bedrock automatically; you do not need AWS credentials to run the dev server.)
4. The agent must expose **exactly two tools**, named **exactly** `searchKnowledgeBase` and `lookupOrderStatus` (the grader's questions are phrased to invoke them by name):
   - **`searchKnowledgeBase`** — parameters `{ query: string }`; its handler calls the knowledge-base block's `retrieve(query, { maxResults })` and returns the hits (each hit's `text` and `source`). **Treat an empty or missing query as a broad lookup** — default it to `'sample'` — so the tool still returns the seeded passage. The agent must **not** crash while the knowledge base is still ingesting: if `retrieve()` throws `KnowledgeBaseErrors.NotReady`, wait briefly and retry until it succeeds (there is **no** `waitUntilReady()`/`isReady()` method — readiness is signalled only by that error).
   - **`lookupOrderStatus`** — returns a **fixed, deterministic** result regardless of its input: `{ status: 'shipped', trackingCode: 'TRK-9F42-OK' }`. (A real implementation would look the order up; for this task a constant is required so the result is checkable.)
5. The agent's system prompt must steer it to call `searchKnowledgeBase` for product / returns / refund questions and `lookupOrderStatus` for order / shipping / tracking questions, and to answer **only** from what those tools return.

### Chat UI
6. A user types a question into `[data-testid=chat-input]` and submits it with `[data-testid=chat-send]`. The question appears immediately as a `[data-testid=message]` bubble with `data-role="user"`, and the agent's reply appears as a `[data-testid=message]` bubble with `data-role="assistant"` inside `[data-testid=message-list]`. Messages accumulate (the list is a transcript).
7. When the agent's reply used a tool, that assistant bubble must contain a `[data-testid=tool-indicator]` (e.g. naming the tool(s) called). When the reply drew on the knowledge base, the bubble must contain a `[data-testid=citation]` naming the source document. The assistant reply text must include what the tool returned (the retrieved passage, or the tracking code).

A single shared assistant — no login.

## Where to look

The project is built on AWS Blocks. The `aws-blocks/` directory is your wiring point. Under `node_modules/@aws-blocks/`, each package has a `README.md` and an `API.md`; **read the agent block's and the knowledge-base block's docs before wiring** — use only methods documented there.

Shapes you'll use (read the READMEs for exact options):

```ts
import { ApiNamespace, Scope, Agent, KnowledgeBase, KnowledgeBaseErrors } from '@aws-blocks/blocks';
import { z } from 'zod';

const scope = new Scope('kb-chat-agent');

const kb = new KnowledgeBase(scope, 'docs', {
  source: './knowledge',
  chunking: { strategy: 'none' },
  description: 'Nimbus-7 product specs and store policies',
});

const agent = new Agent(scope, 'assistant', {
  model: { deployed: { provider: 'bedrock', modelId: 'us.anthropic.claude-sonnet-4-6' } },
  systemPrompt: 'Answer product/returns questions from searchKnowledgeBase and order questions from lookupOrderStatus. Never invent facts.',
  tools: (tool) => ({
    searchKnowledgeBase: tool({
      description: 'Search the product knowledge base.',
      parameters: z.object({ query: z.string() }),
      handler: async ({ input }) => {
        const q = (input?.query ?? '').trim() || 'sample';
        // retry on KnowledgeBaseErrors.NotReady, then:
        const hits = await kb.retrieve(q, { maxResults: 3 });
        return { results: hits.map(h => ({ text: h.text, source: h.source })) };
      },
    }),
    lookupOrderStatus: tool({
      description: 'Look up the current order shipping status.',
      parameters: z.object({ orderId: z.string().optional() }),
      handler: async () => ({ status: 'shipped', trackingCode: 'TRK-9F42-OK' }),
    }),
  }),
});

// One simple way to drive a turn from a backend method: create a conversation,
// stream the message, await completion, then read the history to see which
// tools ran and which sources they cited.
export const api = new ApiNamespace(scope, 'api', (_context) => ({
  async ask(question: string) {
    const conversationId = await agent.createConversationId('demo-user');
    const result = await agent.stream(question, { conversationId, userId: 'demo-user' });
    const done = await result.complete();
    const history = await agent.getConversation(conversationId);
    const toolCalls = history.filter(m => m.role === 'tool-call').map(m => m.metadata?.toolName);
    return { answer: done.text, toolCalls /*, citations from tool-result metadata */ };
  },
}));
```

You may instead stream tokens to the UI with the agent block's framework-agnostic client hook `useChat` — it is **not** re-exported from `@aws-blocks/blocks`; import it from the bb-agent client subpath: `import { useChat } from '@aws-blocks/bb-agent/client'` — driven by its Realtime channel. Either approach is fine, as long as the rendered transcript, tool indicator and citation match the contract below.

The dev server is already running on the port in `/tmp/dev.port`. Edits to `aws-blocks/` reload the backend; edits under `src/` hot-reload the frontend. Use the running app to verify your work.

## Selector contract

The Playwright test grades your work using these `data-testid` hooks and one data attribute. Implement them exactly.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=chat-input]` | `<input type="text">` (or `<textarea>`) | Where the user types a question |
| `[data-testid=chat-send]` | `<button>` | Submits the question to the agent |
| `[data-testid=message-list]` | container | Wraps every chat bubble (the transcript) |
| `[data-testid=message]` | one per message, inside the list | A chat bubble; must render the message text as its content |
| `[data-testid=tool-indicator]` | inside an assistant bubble | Present when that reply used a tool |
| `[data-testid=citation]` | inside an assistant bubble | Present when that reply drew on the knowledge base; names the source document |

Set `data-role` on each `[data-testid=message]`: `"user"` for the person's questions, `"assistant"` for the agent's replies. The test locates a bubble by the text it contains (`filter({ hasText: … })`), so the assistant reply must literally contain the retrieved fact (`QUOKKA-9F42`, `1337`) or the tracking code (`TRK-9F42-OK`).

The mount point for your page is the existing root element / `index.html` body. Replace the template's placeholder content.

## Out of scope

- Authentication, accounts, per-user conversations
- Editing / deleting messages, multiple conversations, conversation list UI
- Real order data — `lookupOrderStatus` returns the fixed constant above
- Streaming/typewriter animation is optional, not required
- Styling beyond what makes the test pass

## Done means

- The dev server responds and the chat works end to end against it.
- `npm run build` exits 0.
- All Playwright assertions in the task spec pass against the running dev server.
- No uncaught errors in the browser console under normal use.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
