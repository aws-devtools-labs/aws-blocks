# @aws-blocks/create-blocks-app

## 0.1.4

### Patch Changes

- ba577bb: List the available starter templates in `create-blocks-app --help` so users can discover valid `--template` values directly from the CLI.

## 0.1.3

### Patch Changes

- bbf0c4a: Add the missing `/.blocks-sandbox/config.json` route handler to the Next.js template so the browser client can discover the API URL.

## 0.1.2

### Patch Changes

- 7b80811: Add in-repo Building Block docs discoverability.

  The `@aws-blocks/blocks` package now ships a `docs/` folder containing every Building Block README (one per block) plus a generated `index.md` with a decision tree and catalog. This gives humans and AI agents a single, stable path to all block documentation — `node_modules/@aws-blocks/blocks/docs/` — instead of scattering them across 19+ individual package paths.

  - `@aws-blocks/blocks`: adds `docs/` to the published package (assembled at build time via `scripts/sync-block-docs.mjs`). README expanded to be a comprehensive guide (architecture, workflow, best practices, common mistakes).
  - `@aws-blocks/create-blocks-app`: AGENTS.md templates updated to point to the blocks README and docs folder as the canonical entry points.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements

## 0.1.0

Initial version
