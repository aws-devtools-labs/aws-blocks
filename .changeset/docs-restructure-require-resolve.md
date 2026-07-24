---
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

docs: per-block docs folders + committed BB catalog with CI sync check; CLAUDE/agents docs resolved via require.resolve

`@aws-blocks/blocks` now ships one docs folder per Building Block under `docs/<block>/`
(`README.md` / `API.md` / `DESIGN.md`), plus a committed, marker-delimited Building Block
catalog in the package README that a `sync-docs --check` CI gate keeps in sync. The README's
catalog section and the scaffolded `AGENTS.md` (`@aws-blocks/create-blocks-app`) now direct
tools and agents to locate docs programmatically via
`require.resolve('@aws-blocks/blocks/docs/<block>/README.md')` (and
`require.resolve('@aws-blocks/blocks/docs/README.md')` for the catalog) rather than assuming a
`node_modules/` path or following the human-facing relative links. Also adds a Security
Considerations section to the package README.
