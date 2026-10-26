---
"@aws-blocks/create-blocks-app": patch
---

docs: point the generated `AGENTS.md` at a docs index instead of a guessed folder

The docs bullet now gives one command that lists the docs folders and prints the block catalog from the docs `README.md`, so agents read folder names (for example `bb-distributed-table`) instead of guessing them from a `<block>/README.md` placeholder. It also names `core/README.md` for `ApiNamespace`, `ApiError` and the typed client, and says to import them from `@aws-blocks/blocks`.
