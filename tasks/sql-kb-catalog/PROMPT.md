# Task: Product Catalog + FAQ Search

Build a product catalog with an FAQ search panel in this AWS Blocks app. Products live in a real SQL table (add + list). A separate panel answers questions by searching over a small folder of FAQ documents.

## Setup (do this first)

The workspace has already been scaffolded. Begin by reading README.md, then do all your edits in this workspace.

This is the `nextjs` template (App Router). Define your backend methods in `aws-blocks/index.ts`.

## Requirements

### Product catalog (SQL)
1. Products are stored in a **SQL table** via the relational database block (PGlite locally). Create the table with a numbered `.sql` migration file (e.g. `aws-blocks/migrations/001_products.sql`).
2. A user types a product name into an input and clicks a button to add it; the new product is `INSERT`ed and then appears in the list.
3. The catalog lists every product, each rendering its name.

### FAQ search (knowledge base)
4. **You must create a `knowledge/` folder** (e.g. `./knowledge/`) containing **at least one `.md` FAQ document**, and point the knowledge-base block at it. Locally the block indexes the folder (TF-IDF) and answers retrieval queries.
5. **Required seed content:** at least one FAQ doc must cover your store's **return / refund policy** and must contain the words **`return`** and **`refund`** (the grader searches for these). Write a real short FAQ (a few Q&A lines) — not a stub.
6. A user types a question into a search input and clicks a button; the panel shows one result row per knowledge-base hit.

## Selector contract

The Playwright test grades your work using these `data-testid` hooks. Implement them exactly.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=product-name-input]` | `<input type="text">` | Where the user types a new product name |
| `[data-testid=add-product-btn]` | `<button>` | Inserts the product into the SQL table |
| `[data-testid=product-item]` | one per product | A catalog row; must render the product's name as its text |
| `[data-testid=kb-query-input]` | `<input type="text">` | Where the user types an FAQ question |
| `[data-testid=kb-search-btn]` | `<button>` | Runs the knowledge-base search |
| `[data-testid=kb-result]` | one per search hit | A single FAQ search result |

A `[data-testid=product-item]` must contain the product's name (the test locates a product via `filter({ hasText: name })`). After a search that matches the seeded FAQ, at least one `[data-testid=kb-result]` must be present.

The mount point for your page is the existing root element / page. Replace the template's placeholder content.

## Out of scope

- Authentication, accounts, per-user catalogs
- Editing / deleting products, prices, inventory, categories
- Vector / Bedrock retrieval — the local TF-IDF index over your `knowledge/` folder is what runs
- Styling beyond what makes the test pass
- Sorting, filtering, pagination

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use, and no server 5xx.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
