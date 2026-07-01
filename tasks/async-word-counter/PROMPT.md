# Task: Async Word Counter

Build an async word counter in this AWS Blocks app. A user submits some text; the counting happens in a background job. The row for that submission starts as "processing" and flips to "done" with the word count once the job finishes. Results survive a page reload.

## Setup (do this first)

The workspace has already been scaffolded and the dev server is running; its port is in `/tmp/dev.port`. Begin by reading README.md, then do all your edits in this workspace.

## Requirements

1. A user types text into an input and clicks submit.
2. Submitting enqueues a background job (do the counting in the job — not inline in the request handler) and immediately adds a row for it whose `data-status` is `"processing"`.
3. The background job counts the words and stores the result in a key/value block keyed by the job id. **Count by whitespace runs only:** trim the text, then split on any run of whitespace (spaces, tabs) — so `one two three four five` is 5, and `"   a   b  "` (leading/trailing + double spaces) is 2. A naive `split(' ')` that counts empty gaps is wrong.
   - **Punctuation is part of a word, not a separator:** only whitespace separates words, so `hello,world foo.bar-baz!` is **3** words, not 5.
   - **Unicode and emoji tokens each count as one word:** `café 日本語 🙂 naïve` is **4** words. Implement the count as `text.trim().split(/\s+/).length` (or equivalent) — do **not** use `\w+` / `\W+`, which miscount punctuation and non-ASCII/emoji characters.
4. **Polling:** the frontend polls for the result; when it's ready the row's `data-status` becomes `"done"` and the row shows the word count.
5. **Persistence (including in-flight jobs):** persist each submission to the key/value block **when you enqueue it** (status `"processing"`, keyed by job id) — not only when it finishes. On load, **restore the whole list from the store** (every job, including still-`processing` ones) and resume polling — not just the most recent submission. A row reloaded **while still processing** must reappear and still resolve to `"done"` with its count. (An app that tracks the job list only in client memory loses an in-flight row on reload — that fails.)
6. **Multiple jobs, keyed by job id:** submitting several times enqueues several independent jobs; each gets its own row and its own correct count. Results must be keyed by **job id**, never by the input text — so submitting the **same text twice** produces **two** independent rows, each with its own result that doesn't bleed into the other.
7. **Input validation:** disable `[data-testid=wc-submit]` whenever the input is empty or whitespace-only (trim before the check); re-enable it once real text is present. Don't enqueue a job for blank input.

A single shared list — no login.

## Where to look

The project is built on AWS Blocks. The `aws-blocks/` directory is your wiring point — backend handlers and CDK constructs live there. Under `node_modules/@aws-blocks/`, each package has a `README.md` and an `API.md` describing what it does and how to use it. Read the relevant ones before deciding which building blocks to use.

You'll need a block that runs background/async work and a key/value block to hold each job's result (keyed by job id) so it survives a reload. Pick whichever ones fit.

The dev server is already running on the port in `/tmp/dev.port`. Edits to `aws-blocks/` reload the backend; edits under `src/` hot-reload the frontend. Use the running app to verify your work.

## Selector contract

The Playwright test grades your work using `data-testid` hooks and one data attribute. Implement them exactly.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=wc-input]` | `<input type="text">` (or `<textarea>`) | Where the user types the text to count |
| `[data-testid=wc-submit]` | `<button>` | Enqueue an async word-count job for the input text |
| `[data-testid=wc-list]` | container | Wraps every job row |
| `[data-testid=wc-item]` | one per job, inside the list | The row for a single job; must also render the submitted text as its content |
| `[data-testid=wc-status]` | inside the item | Renders the job's status |
| `[data-testid=wc-result]` | inside the item | Renders the word count once the job is done |

Set `data-status` on each `[data-testid=wc-item]`: `"processing"` while the job runs, `"done"` once the result is stored. When done, `[data-testid=wc-result]` must show the word count as a bare number (e.g. `5`).

A `[data-testid=wc-item]` must contain the submitted text (the test locates a submission's row via `filter({ hasText: <submitted text> })`, since the job list is shared).

The mount point for your page is the existing root element. You can replace whatever placeholder content the template ships with.

## Out of scope

- Authentication, accounts, per-user lists
- Cancelling or retrying jobs, progress percentages
- Counting anything other than whitespace-separated words
- Styling beyond what makes the test pass
- Ordering, sorting, filtering, search, pagination

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
