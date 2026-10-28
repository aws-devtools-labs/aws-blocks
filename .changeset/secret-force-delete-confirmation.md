---
'@aws-blocks/hosting': minor
'@aws-blocks/core': minor
---

`hosting-secret remove --force` and `blocks secret remove --force` now always need `--yes` (or `-y`) to confirm, in every stage, and print a warning first that names the stage (or says an un-staged value is shared by every stage, including production) and that the delete is immediate with no recovery window. Without `--yes` the command refuses before it calls Secrets Manager. **This changes existing CLI behaviour:** scripts that run `remove --force` must add `--yes`. A plain `remove` is still recoverable, `config` removes are unchanged, and the programmatic `removeValue()` / `removeSecret({ force: true })` stay non-interactive and log the same warning.
