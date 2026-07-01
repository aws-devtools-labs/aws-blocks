# Task: File Gallery

Build a file gallery in this AWS Blocks app. A user uploads a file, sees it listed by name with a working download link, and can delete it. The list survives a page reload.

## Setup (do this first)

The workspace has already been scaffolded. Begin by reading README.md, then do all your edits in this workspace.

## Requirements

1. A user can choose a file and click a button to upload it.
2. Every uploaded file is listed by its name. Names may contain spaces or non-ASCII / unicode characters and must be shown verbatim. Uploading a file whose name matches one already in the gallery **overwrites** it — the gallery shows a single row for that name, serving the latest bytes (no duplicate rows).
3. Each listed file has a download link that points at the stored file — use the storage block's download / presigned URL, not a placeholder. Fetching the link must return the **exact bytes that were uploaded** — byte-for-byte, including **binary (non-text)** files and **empty (0-byte)** files (the file is really stored and served, not just listed by name).
4. Each listed file has a button that deletes it, removing **only that file** from the list and leaving the other files intact.
5. **Persistence:** after a full page reload the list still shows the uploaded files (all of them), and a deleted file stays gone.
6. **No-file upload is safe.** Clicking upload with no file selected must not throw or insert a phantom/blank row — disable the upload button until a file is chosen, or no-op the click. But a file that *is* selected is always uploaded and listed, even when it is empty (0 bytes).

A single shared gallery — no login, no per-user separation.

## Where to look

The project is built on AWS Blocks. The `aws-blocks/` directory is your wiring point — backend handlers and CDK constructs live there. Under `node_modules/@aws-blocks/`, each package has a `README.md` and an `API.md` describing what it does and how to use it. Read the relevant ones before deciding which building blocks to use.

You'll need a block for file storage — one that can store an uploaded file, list what's stored, hand back a download URL, and delete. Pick whichever one fits.

## Selector contract

The Playwright test grades your work using these `data-testid` hooks. Implement them exactly.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=file-input]` | `<input type="file">` | Choose the file to upload |
| `[data-testid=file-upload]` | `<button>` | Upload the chosen file |
| `[data-testid=file-list]` | container | Wraps every uploaded-file row |
| `[data-testid=file-item]` | one per file, inside the list | The row for a single file |
| `[data-testid=file-name]` | inside the item | Renders the file's name |
| `[data-testid=file-download]` | `<a href=...>` inside the item | Download link for that file — a real URL that serves the exact stored bytes, not `#` |
| `[data-testid=file-delete]` | `<button>` inside the item | Deletes only that file |

The mount point for your page is the existing root element. You can replace whatever placeholder content the template ships with.

## Out of scope

- Authentication, accounts, per-user galleries
- Folders, renaming, drag-and-drop, multi-select
- Thumbnails, previews, image processing
- Styling beyond what makes the test pass
- Ordering, sorting, filtering, search, pagination

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
