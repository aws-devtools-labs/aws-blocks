# @aws-cdk-blocks/create-block

Scaffold a new AWS CDK Blocks Building Block (`bb-*`) — inside the AWS CDK Blocks monorepo,
inside your own workspace, or as a standalone package.

```bash
npm create @aws-cdk-blocks/block@latest SearchIndex
# or, inside the cdk-blocks monorepo:
npm run new:bb -- SearchIndex
```

`create-block --help` prints every option and the next steps.

## Modes (auto-detected)

| Mode | When | Result |
|---|---|---|
| **contributor** | inside the cdk-blocks monorepo | generates `packages/bb-<name>` and wires it into `aws-cdk-blocks`, the root `workspaces`, the comprehensive test app, and a changeset |
| **customer** | inside your own npm-workspaces repo | generates `packages/bb-<name>`, registers it in your root `workspaces`, and `npm install`s so your app can import it — no publish; your app code is untouched |
| **external** | anywhere else | generates a standalone `@<scope>/bb-<name>` package (`keywords: ["cdk-blocks"]`), no workspace wiring |

## Options

| Flag | Meaning |
|---|---|
| `<ClassName>` | PascalCase, no `BB` prefix (e.g. `SearchIndex`) → package `bb-search-index` |
| `--dir <path>` | target directory (default: derived from the package name) |
| `--scope <npm-scope>` | npm scope for customer/external mode |
| `--yes`, `-y` | accept defaults / skip the confirmation prompt |
| `--skip-install` | do not run `npm install` |
| `--skip-verify` | do not build + test the generated block afterward |
| `--dry-run` | print what would be generated/wired, write nothing |
| `--help`, `-h` | full usage |

## What it generates

A Building Block: a `Scope` subclass with one strongly-typed API,
backed by the four conditional-export entries — `index.mock.ts` (local dev +
tests), `index.aws.ts` (deployed Lambda runtime), `index.cdk.ts` (CDK synth), and
`index.browser.ts` (browser stub) — plus `types.ts`, `errors.ts`, `README.md`,
`DESIGN.md`, and the package config. The code is a storage-agnostic skeleton with
an example method and `TODO` markers; fill it in with your block's real API. See
`packages/bb-kv-store` for a worked example.

For the internals of the CLI itself, see [`DESIGN.md`](./DESIGN.md).
