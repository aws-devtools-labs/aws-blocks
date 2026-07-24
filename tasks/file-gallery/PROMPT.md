# Task: File Gallery

Build a file gallery in this AWS Blocks app. A user uploads a file, sees it listed by name with a working download link, and can delete it. The list survives a page reload.

The core of this task is **using the framework**: files are stored, listed, served, and deleted through an **`api` namespace** backed by the app's **file-storage block**. The page is a thin client over that API.

## Setup (do this first)

The workspace has already been scaffolded. Begin by reading README.md (and any AGENTS.md), then do all your edits in this workspace.

## Requirements

### The `api` namespace (primary surface)

Expose an **`api` namespace** (the framework's server-side RPC surface — a `POST /aws-blocks/api` JSON-RPC endpoint) with these methods, each storing/serving real bytes through the **file-storage block** (not an in-memory map):

1. **`api.putFile(name, contentBase64)`** — stores a file under `name` from the base64-encoded bytes and returns `{ name, size }` where `size` is the exact byte length. Storing a `name` that already exists **overwrites** it (one entry per name, latest bytes). Names may contain spaces or non-ASCII / unicode characters and are preserved verbatim. Storing an **empty (0-byte)** file is valid and returns `size: 0`. A **missing `name`** or **missing/invalid base64** is rejected with a JSON-RPC **error** envelope (no entry created).
2. **`api.listFiles()`** — returns an array of `{ name, size, url }`, one per stored file. `url` is a **real download URL from the storage block** (its download / presigned URL) that serves the **exact stored bytes** — not `#`, not a placeholder. Fetching a file's `url` must return the uploaded bytes **byte-for-byte**, including binary (non-UTF-8) and empty files.
3. **`api.deleteFile(name)`** — deletes **only** that file and returns `{ deleted: name }`; other files are untouched. The removal persists (a subsequent `listFiles` no longer includes it).

### The page (thin client / light smoke)

1. A user can choose a file (`<input type="file">`) and click a button to upload it. The button reads the chosen file and calls `api.putFile` (base64-encoding its bytes) — it must route through the API / storage block, not keep files only in the browser.
2. The page lists every stored file (from `api.listFiles`) by name, each row with a working download link (the storage `url`) and a delete button (calls `api.deleteFile`). The list survives a full reload (it re-reads from `api.listFiles`).
3. **No-file upload is safe:** clicking upload with no file selected must not throw or insert a phantom/blank row — disable the button until a file is chosen, or no-op the click.

A single shared gallery — no login, no per-user separation.

## Selector contract

The page smoke test uses these `data-testid` hooks. Implement them exactly.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=file-input]` | `<input type="file">` | Choose the file to upload |
| `[data-testid=file-upload]` | `<button>` | Upload the chosen file (calls `api.putFile`) |
| `[data-testid=file-list]` | container | Wraps every uploaded-file row |
| `[data-testid=file-item]` | one per file, inside the list | The row for a single file |
| `[data-testid=file-name]` | inside the item | Renders the file's name |
| `[data-testid=file-download]` | `<a href=...>` inside the item | Download link (the storage `url`) — a real URL, not `#` |
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
