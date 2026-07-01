# Required @aws-blocks Building Blocks

All Building Blocks are imported from `@aws-blocks/blocks`. The implementation must route the task's core behavior through the real block API below — not an in-memory Map/array, a hardcoded result, or an inline stub.

- Database — the relational SQL table for products (PGlite locally), created via a numbered `.sql` migration. Expect `db.execute(...)` (INSERT) and `db.query(...)` (SELECT), built with the `sql` tagged template.
- KnowledgeBase — TF-IDF retrieval over the self-seeded `./knowledge` FAQ folder. Expect `kb.retrieve(query, { maxResults })`.
