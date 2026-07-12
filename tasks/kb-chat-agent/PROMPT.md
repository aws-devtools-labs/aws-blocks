# Task: Knowledge-Base Chat Agent with Tool Use

Build a chat assistant in this AWS Blocks app. A user types a question; an AI **agent** answers it. The agent must be able to (a) look facts up in a **knowledge base** you seed from a local folder of documents, and (b) call at least one **tool** to take an action.

The core of this task is **using the framework**: the agent turn — retrieval, tool calls, and the final answer — runs through an **`api` namespace** method backed by the **agent block**. The chat page is a thin client over that API.

## Setup (do this first)

The workspace has already been scaffolded. Begin by reading `README.md` and `AGENTS.md`, then do all your edits in this workspace.

Replace the scaffold's starter content with your chat UI.

## Requirements

### Knowledge base (seed it yourself)
1. **Create a `knowledge/` folder** containing **at least one `.md` document**, and point a knowledge-base block at that folder. Locally the block indexes the folder with a TF-IDF stub and answers retrieval queries; in the cloud it is backed by Bedrock.
2. **Required seed content.** One document must be a short Nimbus-7 product sheet that records, in a single passage, **all** of:
   - the product's internal product code **`QUOKKA-9F42`**,
   - its maximum hover altitude of **`1337 centimeters`**,
   - its factory calibration code **`NBS-7Q6X`** (a second, distinct fact from the product code),
   - the word **`sample`**.

   These four facts must appear **only** in the knowledge base — nowhere in your frontend or backend source — so that an answer repeating them proves a real retrieval happened. The same (or another) document must also describe the **return / refund policy** and contain the word **`refund`**. Write real prose, not a stub. Configure the block's chunking so this whole passage stays in a single chunk.

### Agent + tools
3. Wire an **agent block** whose deployed model is Amazon Bedrock with the Claude Sonnet 4.6 inference profile — model id exactly **`us.anthropic.claude-sonnet-4-6`**. (Locally a lightweight mock stands in for Bedrock — no AWS creds needed to run the dev server.)
4. The agent must expose **exactly two tools**, named **exactly** `searchKnowledgeBase` and `lookupOrderStatus`:
   - **`searchKnowledgeBase`** — takes a search query and returns matching passages from the knowledge base (each hit's text and its source document). **Treat an empty or missing query as a broad lookup** — default it to `'sample'`.
   - **`lookupOrderStatus`** — returns a **fixed, deterministic** result regardless of its input: `{ status: 'shipped', trackingCode: 'TRK-9F42-OK' }`.
5. The agent's system prompt must steer it to call `searchKnowledgeBase` for product / returns / refund questions and `lookupOrderStatus` for order / shipping / tracking questions, and to answer **only** from what those tools return.

### The `api` namespace (primary surface)

Expose an **`api` namespace** (the framework's server-side RPC surface — `POST /aws-blocks/api`) with:

- **`api.ask(message)`** — runs one agent turn through the **agent block** and returns structured data `{ reply, toolsUsed, citations }`:
  - `reply` — the agent's answer text. It must literally contain what the tool returned: the retrieved fact (`QUOKKA-9F42`, `1337`, `NBS-7Q6X`) for KB questions, or the tracking code (`TRK-9F42-OK`) for order questions.
  - `toolsUsed` — an array of the tool names the agent invoked this turn (`"searchKnowledgeBase"` and/or `"lookupOrderStatus"`); empty when no tool ran.
  - `citations` — an array of source-document names when the reply drew on the knowledge base; empty otherwise.
  A blank/empty `message` is rejected with a JSON-RPC **error** envelope.

### Chat UI (thin client / light smoke)
6. A user types a question into `[data-testid=chat-input]` and submits with `[data-testid=chat-send]`. The question appears immediately as a `[data-testid=message]` bubble with `data-role="user"`; the agent's reply (from `api.ask`) appears as a `[data-testid=message]` bubble with `data-role="assistant"` inside `[data-testid=message-list]`. Messages accumulate (the list is a transcript).
7. When the reply used a tool, that assistant bubble contains a `[data-testid=tool-indicator]`; when it drew on the knowledge base, the bubble contains a `[data-testid=citation]` naming the source document.

A single shared assistant — no login.

## Selector contract

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=chat-input]` | `<input type="text">` (or `<textarea>`) | Where the user types a question |
| `[data-testid=chat-send]` | `<button>` | Submits the question to the agent (`api.ask`) |
| `[data-testid=message-list]` | container | Wraps every chat bubble (the transcript) |
| `[data-testid=message]` | one per message, inside the list | A chat bubble; renders the message text as its content |
| `[data-testid=tool-indicator]` | inside an assistant bubble | Present when that reply used a tool |
| `[data-testid=citation]` | inside an assistant bubble | Present when that reply drew on the knowledge base; names the source document |

Set `data-role` on each `[data-testid=message]`: `"user"` for questions, `"assistant"` for replies. The assistant reply must literally contain the retrieved fact (`QUOKKA-9F42`, `1337`, `NBS-7Q6X`) or the tracking code (`TRK-9F42-OK`).

The mount point for your page is the existing root element. Replace the template's placeholder content.

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
