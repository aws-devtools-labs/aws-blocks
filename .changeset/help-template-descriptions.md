---
"@aws-blocks/create-blocks-app": patch
---

Improve `--help` output for `create-blocks-app`:

- Template discovery is now filesystem-driven — drop a folder under `templates/` with a `package.json` and it auto-registers.
- `--help` now lists every template with a one-line description, sourced from each template's `blocksTemplateDescription` field.
- Added `--yes --template nextjs` to the Examples section.
