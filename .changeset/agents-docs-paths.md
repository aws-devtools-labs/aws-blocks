---
"@aws-blocks/create-blocks-app": patch
---

docs: correct the docs folder paths in the generated `AGENTS.md`

Building Block docs live in folders named after their package (for example `bb-kv-store/README.md`), and `ApiNamespace`,
`ApiError` and the typed client are documented in `core/README.md`. The generated `AGENTS.md` now names these paths.
