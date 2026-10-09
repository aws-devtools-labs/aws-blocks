# Building Block Layer Architecture

A Building Block (BB) is one npm package that exposes **one class name** with **up to four implementations**, one per place the code runs. Node.js [conditional exports](https://nodejs.org/api/packages.html#conditional-exports) pick the implementation, so application code writes `new KVStore(scope, 'todos')` once and gets a local store in development, a DynamoDB table at synth, and SDK calls in Lambda.

This page explains the model. For the files a BB contains and how to write each one, see [Building Block Structure](./building-block-structure.md). The canonical reference implementation is [`packages/bb-kv-store`](../../packages/bb-kv-store/).

## The four layers

Every BB `package.json` maps one export path to the four layer files:

```jsonc
"type": "module",
"exports": {
  ".": {
    "browser":     "./dist/index.browser.js",                                    // browser bundles
    "cdk":         { "types": "./dist/index.cdk.d.ts", "default": "./dist/index.cdk.js" },
    "aws-runtime": "./dist/index.aws.js",                                        // deployed Lambda
    "types":       "./dist/index.mock.d.ts",                                     // types resolve to the mock
    "default":     "./dist/index.mock.js"                                        // local dev + tests
  }
}
```

| Layer | File | Selected by | Runs when | Does |
|---|---|---|---|---|
| Mock | `index.mock.ts` | `default` (and `types`) | `npm run dev`, unit and e2e tests | Implements the full API locally and persists to `.bb-data/{fullId}/` |
| CDK | `index.cdk.ts` | `cdk` | CDK synth, run with `--conditions=cdk` | Provisions the AWS resources, grants IAM on the shared execution role, registers extra config; every runtime method is a `synthGuard` stub |
| AWS runtime | `index.aws.ts` | `aws-runtime` | inside the deployed Lambda (bundled by esbuild with `--conditions aws-runtime`) | Implements the API with the AWS SDK |
| Browser | `index.browser.ts` | `browser` | client bundles | Re-exports types and error constants; the class is a stub, because data methods are server-side only |

Things that follow from this:

- **Synth must run with `--conditions=cdk`.** Without it, Node falls through to `default` and loads the mocks, so synth would produce no infrastructure. `BlocksStack` and `BlocksBackend` throw at construction when the flag is missing.
- **Types resolve to the mock.** `"types"` points at `index.mock.d.ts`, so the mock's public types are the BB's public types. Every named export of `index.mock.ts` must also exist in the `cdk`, `aws-runtime` and `browser` entries; `packages/blocks/src/conditional-exports.test.ts` enforces it.
- **Data methods run only inside handlers.** Under `--conditions=cdk` they are `synthGuard` stubs that throw, so calling one at module top level fails synth with an explanation instead of silently doing nothing.

## How the layers agree on resource names

The layers never pass resource names to each other. Each derives the same name from the instance's `fullId` (its scoped id, e.g. `app-notes`) independently:

1. The **CDK layer** provisions the resource with a name derived from `this.fullId` (e.g. `tableName: this.fullId.substring(0, 255)`).
2. The **AWS runtime layer** computes the same name in its constructor and records it with `registerSdkIdentifiers(this.fullId, { tableName })`.
3. The **mock layer** registers a `mock-`-prefixed name the same way.
4. Methods resolve names **at call time** with `getSdkIdentifiers(this)`, never by caching them in the constructor. The registry is per process, so co-located BBs can find each other's resources.

`fromExisting(…)` follows the same path: it returns a lightweight **reference object** (e.g. `{ tableName }`) that you pass into the constructor, and every layer uses the referenced name instead of the derived one.

## Configuration beyond names

When the CDK layer must tell the runtime something it cannot derive (a token-valued ARN, a feature flag), it calls `registerConfig(this, 'BLOCKS_…', value)` from `@aws-blocks/core/cdk`. Entries are written to one JSON file in S3 at synth time, and the Lambda handler loads them into `process.env` at cold start. Never use `handler.addEnvironment()` for BB config: Lambda environment variables are capped at about 4 KB for the whole function.

## Composition

A BB can build on other BBs by constructing them with itself as the parent, under fixed child ids, in each of its layers. Because the child is imported by its package name, the same conditional exports resolve it to the matching layer: the parent's CDK layer gets the child's CDK class, and its mock layer gets the child's mock.

`Auth` ([`packages/bb-auth`](../../packages/bb-auth/)) is the example: every layer composes a `KVStore` named `sessions` and a secret `AppSetting` named `session-secret` (`src/index.cdk.ts`, `src/sessions.ts`, `src/index.aws.ts`). A configuration with only directly federated OIDC providers provisions nothing else, so the composed BBs are its whole infrastructure. Child ids are part of the resource identity: renaming one makes CloudFormation replace the resource.

## Values that cross the wire

An `ApiNamespace` method returns plain JSON-serializable data. A BB that must hand the client a live object (a realtime channel, a file handle) returns a **Transferable**: its `toJSON()` produces a `{ __blocks: '<type>', … }` descriptor, and a client plugin registered with `scope.registerClientMiddleware(pkg)` re-hydrates it in the browser. [`packages/bb-realtime`](../../packages/bb-realtime/) is the end-to-end example. A BB instance itself (a `Scope` subclass) is server-only and never crosses the wire.

## See also

- [Building Block Structure](./building-block-structure.md) — the files in a BB package and what goes in each
- [`AGENTS.md`](../../AGENTS.md) — the contributor guide, including the checklist for a new BB
- [`docs/design/API-DESIGN.md`](../design/API-DESIGN.md) — API guidelines G1–G18
