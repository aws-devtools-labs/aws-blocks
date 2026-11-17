# create-block — Design

`@aws-blocks/create-block` scaffolds a new Building Block (`bb-*`) package and, in
the AWS Blocks monorepo, wires it into every registration touchpoint. This
documents the internals; see [`README.md`](./README.md) for usage.

## Goals

- Turn the "copy `bb-kv-store`, rename, and hand-wire six touchpoints" ritual into
  one command that produces a package which **builds and tests green immediately**.
- Zero runtime dependencies — Node stdlib only, mirroring `create-blocks-app`.

## Auto-detected modes

The CLI walks up from the working directory and picks a mode from what it finds:

| Mode | Trigger | What it does |
|---|---|---|
| **contributor** | a `package.json` whose `workspaces` includes `packages/blocks` (i.e. this monorepo) | generates `packages/bb-<name>` and performs all six touchpoints below |
| **customer** | a `package.json` that declares npm `workspaces` but is **not** the Blocks repo | generates `packages/bb-<name>`, registers it in the root `workspaces` (unless a `packages/*` glob already covers it), and `npm install`s so the app can import it — no publish, no app-code edits |
| **external** | anywhere else | generates a standalone `@<scope>/bb-<name>` package tagged `keywords: ["aws-blocks"]`, no workspace wiring |

`findMonorepoRoot` / `findCustomerWorkspaceRoot` implement the detection;
contributor takes priority over customer, customer over external.

## Templating

Templates live in `templates/primitive/` and are plain files containing two
tokens — `__BB_CLASS__` (the PascalCase class name) and `__BB_PKG_NAME__` (the
full npm name). `copyTemplate` copies the tree and `substituteTokens` replaces
both in every file's contents. `version.ts` is **not** templated — it is produced
by the package's `prebuild` step.

The generated block is a **primitive** shape: a `Scope` subclass with the four
conditional-export entries (`index.cdk/aws/mock/browser.ts`) plus
`types.ts`/`errors.ts`. It is a storage-agnostic skeleton with one example method
and `TODO`s — deliberately not a specific data model — so any block starts clean.

## Contributor-mode wiring (the six touchpoints)

`wireContributor` runs inside `try/finally`, so a mid-way failure still reports
what already landed. Each JSON/text edit records whether it actually changed
anything (`… (already present)` otherwise). The touchpoints:

1. `packages/blocks/src/index.ts` — runtime/mock re-export (via HTML markers)
2. `packages/blocks/src/index.cdk.ts` — CDK re-export (via HTML markers)
3. `packages/blocks/package.json` — `dependencies` + the `aws-blocks.vendorize` map
4. `packages/blocks/tsconfig.json` — a project reference
5. root `package.json` `workspaces` — append `packages/bb-<name>`
6. `test-apps/comprehensive` — dependency + a starter `test/<name>.test.ts`

…then a changeset is written and `npm run sync-docs` regenerates the README
catalog. Re-export insertion uses idempotent `<!-- BEGIN/END:generated-block-exports -->`
markers so re-running never double-adds.

## Dependency pinning (why it differs by mode)

The templates pin monorepo-internal versions, which don't match the published
registry. So:

- **contributor** re-pins `@aws-blocks/*` deps to the monorepo's **current local**
  versions (`^x.y.z`, matching sibling BBs) so npm links the workspace copies.
- **customer / external** re-pin them to the **latest published** versions
  (`npm view`, falling back to `latest` offline), and rewrite `prebuild` to a
  standalone `scripts/generate-version.mjs` (no monorepo `scripts/`), swap the
  tsconfig for a self-contained one, and drop the CDK synth test (its harness
  depends on core-version-specific Stack attachment). The runtime + parity tests
  still ship.

## Testing

`src/index.test.ts` covers the pure helpers (name/scope validation, kebab
derivation, token substitution, marker insertion, mode detection) plus
`run()`-level integration tests (customer mode + dry-run) that exercise the
file-writing and JSON-mutation paths. Registry lookups are skipped in tests via
`CREATE_BLOCK_SKIP_REGISTRY`.
