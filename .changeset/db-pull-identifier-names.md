---
"@aws-blocks/bb-data": patch
---

`db pull` now validates table and column names and quotes them in generated code

`db pull` and the `npm run dev` type refresh accept table, column, and primary key names that match `^[A-Za-z_][A-Za-z0-9_]*$` (ASCII letters, digits, and underscores, not starting with a digit). For any other name, they stop before writing files, with an error that names the table and column to rename. Every name written into `database.types.ts`, `database.meta.ts`, and `MIGRATION_GUIDE.md` is also quoted as a string literal or property key. Output for existing plain names is unchanged.
