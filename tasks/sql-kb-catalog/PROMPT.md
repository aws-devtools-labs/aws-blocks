# Task: Product Catalog + FAQ Search

Build a product catalog with an FAQ search panel in this AWS Blocks app. Products live in a real SQL table (add + list). A separate panel answers questions by searching over a small folder of FAQ documents.

The core of this task is **using the framework**: products are added and listed through an **`api` namespace** backed by the **relational database block**, and FAQ answers come from the **knowledge-base block**. The page is a thin client over that API.

## Setup (do this first)

The workspace has already been scaffolded. Begin by reading README.md (and any AGENTS.md), then do all your edits in this workspace.

## Requirements

### The `api` namespace (primary surface)

Expose an **`api` namespace** (the framework's server-side RPC surface — a `POST /aws-blocks/api` JSON-RPC endpoint) with these methods:

1. **`api.addProduct(name)`** — `INSERT`s a product row into the **SQL table** via the relational database block (PGlite locally) and returns the created row `{ id, name }` (`id` a number). A blank/whitespace-only or non-string `name` is rejected with a JSON-RPC **error** envelope (no row inserted).
2. **`api.listProducts()`** — returns every product as `[{ id, name }]`, read back from the SQL table, in a stable order (oldest first / ascending `id`). Because rows live in real SQL, they persist across reloads and process restarts.
3. **`api.searchKb(query)`** — runs a retrieval query against the **knowledge-base block** (local TF-IDF over your `knowledge/` folder) and returns an array of hits, each `{ text }` (the matched FAQ snippet/text). An empty/blank query returns an empty array (no error).

You must create the SQL table with a numbered `.sql` migration file (e.g. `aws-blocks/migrations/001_products.sql`).

### The knowledge base (real seeded content)

- **Create a `knowledge/` folder** (e.g. `./knowledge/`) containing **at least one real `.md` FAQ document**, and point the knowledge-base block at it.
- **Required seed content:** at least one FAQ doc must cover your store's **return / refund policy** and must contain the words **`return`** and **`refund`** (the grader searches for these and asserts the returned snippet really contains them). Write a real short FAQ (a few Q&A lines) — not a stub.

### The page (thin client / light smoke)

1. A product-name input + add button (calls `api.addProduct`); the catalog lists every product (from `api.listProducts`), one row per product rendering its name.
2. An FAQ question input + search button (calls `api.searchKb`); the panel shows one result row per hit.

## Selector contract

The page smoke test uses these `data-testid` hooks. Implement them exactly.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=product-name-input]` | `<input type="text">` | Where the user types a new product name |
| `[data-testid=add-product-btn]` | `<button>` | Inserts the product (calls `api.addProduct`) |
| `[data-testid=product-item]` | one per product | A catalog row; renders the product's name as its text |
| `[data-testid=kb-query-input]` | `<input type="text">` | Where the user types an FAQ question |
| `[data-testid=kb-search-btn]` | `<button>` | Runs the knowledge-base search (`api.searchKb`) |
| `[data-testid=kb-result]` | one per search hit | A single FAQ search result |

A `[data-testid=product-item]` must contain the product's name. After a search that matches the seeded FAQ, at least one `[data-testid=kb-result]` must be present.

The mount point for your page is the existing root element / page. Replace the template's placeholder content.

## Out of scope

- Authentication, accounts, per-user catalogs
- Editing / deleting products, prices, inventory, categories
- Vector / Bedrock retrieval — the local TF-IDF index over your `knowledge/` folder is what runs
- Styling beyond what makes the test pass
- Sorting, filtering, pagination

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
