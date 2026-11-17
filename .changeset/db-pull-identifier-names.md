---
"@aws-blocks/bb-data": minor
---

`db pull` now validates table and column names and quotes them in generated code

`db pull` and the `npm run dev` type refresh accept table, column, and primary key names that are TypeScript identifiers (`^[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*$`: Unicode letters, digits, underscores, and `$`, not starting with a digit). For any other name, and for a table whose generated type name would clash with a name the generated files use (such as `table_meta` → `TableMeta` or `record` → `Record`), they stop before writing files, with an error that names the table and column to rename. Every name written into `database.types.ts`, `database.meta.ts`, and `MIGRATION_GUIDE.md` is also quoted as a string literal or property key. Output for names made only of ASCII letters, digits, and underscores is unchanged.
