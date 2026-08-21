---
"@aws-blocks/create-block": minor
---

Add `@aws-blocks/create-block` — a scaffolder for new Building Blocks.

`npm create @aws-blocks/block@latest <ClassName>` (or `npm run new:bb` inside this repo) generates a complete `bb-*` package: the conditional-export layers (`index.mock/aws/cdk/browser.ts` + `types.ts`/`errors.ts`), `README.md`/`DESIGN.md`, `package.json`, `tsconfig.json`, `api-extractor.json`, and passing `node:test` suites (behavior, export parity, and CDK synth). Three block shapes are supported — `primitive` (owns infrastructure), `composite` (composes other blocks), and `client-facing` (browser client plugin) — matching the taxonomy in the building-block architecture design.

The CLI auto-detects its context:

- **Contributor mode** (run inside the aws-blocks monorepo): also wires the block into `@aws-blocks/blocks` (runtime + CDK re-exports, dependency, and vendorize map, via idempotent HTML markers), the root `workspaces`, the `comprehensive` test app, and a changeset; then regenerates the README catalog via `sync-docs`.
- **External mode** (run anywhere else): generates a standalone `@<scope>/bb-<name>` package tagged `keywords: ["aws-blocks"]` with a self-contained build, no monorepo wiring.

Zero runtime dependencies (Node stdlib only). Flags: `--type`, `--dir`, `--scope`, `--yes`, `--skip-install`, `--skip-verify`, `--dry-run`.
