# Task: Async Word Counter

Build an async word counter in this AWS Blocks app. A user submits some text; the counting happens in a **background job**. A submission starts as `"processing"` and flips to `"done"` with its word count once the job finishes. Results are persisted and survive a reload.

The core of this task is **using the framework**: submissions are enqueued and read through an **`api` namespace** whose methods run on the server, do the counting in a **background job block**, and persist each job in a **key/value block** keyed by job id. The page is a thin client that polls that API.

## Setup (do this first)

The workspace has already been scaffolded. Begin by reading README.md (and any AGENTS.md), then do all your edits in this workspace.

## Requirements

### The `api` namespace (primary surface)

Expose an **`api` namespace** (a `POST /aws-blocks/api` JSON-RPC endpoint) with these methods:

1. **`api.enqueue(text)`** — enqueues a background word-count job for `text` and returns the new job's id as `{ "id": <string> }` (a non-empty job id). It must:
   - do the counting in a **background job** (the AsyncJob block) — **not** inline in the request handler;
   - **persist the job at enqueue time** with status `"processing"`, keyed by job id, in the key/value block (not only when it finishes);
   - **validate the input** — `text` that is empty or whitespace-only (trim first) is rejected with a JSON-RPC **error** envelope and enqueues **no** job.
2. **`api.getJob(id)`** — returns the job as exactly `{ "id": <string>, "text": <string>, "status": "processing" | "done", "count": <number|null> }`. `count` is the word count once `status === "done"` (and may be `null`/absent while processing). An **unknown** id returns a JSON-RPC **error** envelope (not a bogus success).
3. **`api.listJobs()`** — returns an array of every job (each the same `{ id, text, status, count }` shape), **restored from the store** — including still-`processing` ones. This is what lets the page rebuild its list on load.

**Word count — count by whitespace runs only.** Trim the text, then split on any run of whitespace (spaces, tabs, newlines): `one two three four five` is `5`, and `"   a   b  "` is `2` (a naive `split(' ')` that counts empty gaps is wrong). **Punctuation is part of a word, not a separator** — `hello,world foo.bar-baz!` is `3`. **Unicode and emoji tokens each count as one word** — `café 日本語 🙂 naïve` is `4`. Count each maximal run of non-whitespace as one word; do **not** use `\w+` / `\W+` (they miscount punctuation and non-ASCII/emoji).

**Keyed by job id, never by text.** Submitting the **same text twice** produces **two** independent jobs, each with its own id and its own result — results must never bleed between jobs or collapse into one.

### The page (thin client / light smoke)

1. A text input (`[data-testid=wc-input]`) and a submit button (`[data-testid=wc-submit]`). Disable submit whenever the input is empty or whitespace-only (trim before checking); re-enable it once real text is present.
2. Submitting calls `api.enqueue`, then the page polls (`api.getJob` / `api.listJobs`) and renders a row per job inside `[data-testid=wc-list]`.
3. On load, the list is rebuilt from `api.listJobs` (every job, including still-processing ones) and polling resumes — so a row reloaded while still processing reappears and still resolves to `"done"`.

## Selector contract

The page smoke test uses these hooks. Implement them exactly.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=wc-input]` | `<input type="text">` (or `<textarea>`) | Where the user types the text to count |
| `[data-testid=wc-submit]` | `<button>` | Enqueue a job (calls `api.enqueue`) |
| `[data-testid=wc-list]` | container | Wraps every job row |
| `[data-testid=wc-item]` | one per job, inside the list | The row for a single job; must render the submitted text as its content |
| `[data-testid=wc-status]` | inside the item | Renders the job's status |
| `[data-testid=wc-result]` | inside the item | Renders the word count (a bare number, e.g. `5`) once done |

Set `data-status` on each `[data-testid=wc-item]`: `"processing"` while running, `"done"` once the result is stored. A `[data-testid=wc-item]` must contain the submitted text (the smoke test locates a row via `filter({ hasText: <submitted text> })`).

The mount point for your page is the existing root element. You can replace whatever placeholder content the template ships with.

## Out of scope

- Authentication, accounts, per-user lists
- Cancelling or retrying jobs, progress percentages
- Counting anything other than whitespace-separated words
- Ordering, sorting, filtering, search, pagination
- Styling beyond what makes the test pass

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
