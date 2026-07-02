# Task: Knowledge-Base Chat Agent with Tool Use

Build a chat assistant in this AWS Blocks app. A user types a question; an AI **agent** answers it. The agent must be able to (a) look facts up in a **knowledge base** you seed from a local folder of documents, and (b) call at least one **tool** to take an action. Each answer is shown as a chat bubble, the questions and answers accumulate in a message list, and when the agent uses a tool or cites a document the UI shows that.

## Setup (do this first)

The workspace has already been scaffolded. Begin by reading `README.md` and `AGENTS.md`, then do all your edits in this workspace.

This is the `demo` template — a vanilla TypeScript + Vite frontend (`index.html` + `src/index.ts`), with the backend wired in `aws-blocks/index.ts`. Replace the template's placeholder demo (todos / KV / cookies) with your chat UI.

## Requirements

### Knowledge base (seed it yourself)
1. **Create a `knowledge/` folder** containing **at least one `.md` document**, and point a knowledge-base block at that folder. Locally the block indexes the folder with a TF-IDF stub and answers retrieval queries; in the cloud it is backed by Bedrock.
2. **Required seed content.** One document must be a short Nimbus-7 product sheet that records, in a single passage, **all** of:
   - the product's internal product code **`QUOKKA-9F42`**,
   - its maximum hover altitude of **`1337 centimeters`**,
   - its factory calibration code **`NBS-7Q6X`** (a second, distinct fact from the product code — the grader asks for it separately to prove the assistant surfaces the *actual retrieved passage* rather than a hard-coded product-code string),
   - the word **`sample`** (the local index is probed with a generic term, and the grader relies on this word being in the same passage as the facts above).

   These four facts must appear **only** in the knowledge base — nowhere in your frontend or backend source — so that an answer repeating them proves a real retrieval happened. The same (or another) document must also describe the **return / refund policy** and contain the word **`refund`**. Write real prose, not a stub. Configure the block's chunking so this whole passage stays in a single chunk, rather than being split apart.

### Agent + tools
3. Wire an **agent block** whose deployed model is Amazon Bedrock with the Claude Sonnet 4.6 inference profile — model id exactly **`us.anthropic.claude-sonnet-4-6`**. (Locally a keyword-driven mock stands in for Bedrock automatically; you do not need AWS credentials to run the dev server.)
4. The agent must expose **exactly two tools**, named **exactly** `searchKnowledgeBase` and `lookupOrderStatus` (the grader's questions are phrased to invoke them by name):
   - **`searchKnowledgeBase`** — takes a search query and returns matching passages from the knowledge base (each hit's text and its source document). **Treat an empty or missing query as a broad lookup** — default it to `'sample'` — so the tool still returns the seeded passage.
   - **`lookupOrderStatus`** — returns a **fixed, deterministic** result regardless of its input: `{ status: 'shipped', trackingCode: 'TRK-9F42-OK' }`. (A real implementation would look the order up; for this task a constant is required so the result is checkable.)
5. The agent's system prompt must steer it to call `searchKnowledgeBase` for product / returns / refund questions and `lookupOrderStatus` for order / shipping / tracking questions, and to answer **only** from what those tools return.

### Chat UI
6. A user types a question into `[data-testid=chat-input]` and submits it with `[data-testid=chat-send]`. The question appears immediately as a `[data-testid=message]` bubble with `data-role="user"`, and the agent's reply appears as a `[data-testid=message]` bubble with `data-role="assistant"` inside `[data-testid=message-list]`. Messages accumulate (the list is a transcript).
7. When the agent's reply used a tool, that assistant bubble must contain a `[data-testid=tool-indicator]` (e.g. naming the tool(s) called). When the reply drew on the knowledge base, the bubble must contain a `[data-testid=citation]` naming the source document. The assistant reply text must include what the tool returned (the retrieved passage, or the tracking code).

A single shared assistant — no login.

## Where to look

The project is built on AWS Blocks. The `aws-blocks/` directory is your wiring point. Under `node_modules/@aws-blocks/`, each package has a `README.md` and an `API.md` describing what it does and how to use it. You'll need an agent block and a knowledge-base block — read the relevant ones before wiring.

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

Set `data-role` on each `[data-testid=message]`: `"user"` for the person's questions, `"assistant"` for the agent's replies. The test locates a bubble by the text it contains (`filter({ hasText: … })`), so the assistant reply must literally contain the retrieved fact (`QUOKKA-9F42`, `1337`, `NBS-7Q6X`) or the tracking code (`TRK-9F42-OK`).

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
