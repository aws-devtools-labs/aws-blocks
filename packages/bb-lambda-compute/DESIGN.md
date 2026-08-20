# LambdaCompute — Design

Design document for `@aws-blocks/bb-lambda-compute`. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-lambda-compute`
**Type:** Compute (framework infrastructure, not a customer-facing data block)
**AWS Services:** Lambda (`NodejsFunction`) + API Gateway (REST)

## Why a compute is a Building Block

A Blocks app runs its handler code on a *compute*. Modeling compute as a
first-class type — rather than inlining a Lambda and API Gateway in core — lets
one app run on multiple compute targets (Lambda, containers, customer-owned) and
target namespaces and handlers at specific ones.

`Compute` (the abstract base) lives in `@aws-blocks/core` because it is a
framework primitive: `Scope`, the base every block extends, resolves the compute
a handler runs on, so the type it resolves to must be visible to core. The
concrete `LambdaCompute` lives in its own package so core never depends on a
concrete compute implementation — the same package-boundary split the framework
uses for client middleware, where core defines the seam and a block package
supplies the implementation.

## Infrastructure (CDK)

`LambdaCompute extends Compute` and, in its constructor, provisions and owns:

- **A `NodejsFunction`** — 2048 MB memory, 15-minute timeout, `NODE_ENV=production`,
  bundled with `--conditions=aws-runtime` so blocks resolve their runtime (not
  CDK/mock) entry points. It assumes the **shared Blocks execution role**
  (`this.executionRole`) rather than an auto-generated per-function role, so
  Building Block grants — which target that shared role — reach it.
- **An API Gateway REST API** fronting the function:
  - the `/aws-blocks` resource gets a proxy so `RawRoute` sub-paths reach the
    function;
  - `/aws-blocks/api` gets explicit `POST` + `OPTIONS` methods (the JSON-RPC
    endpoint);
  - the root gets a catch-all proxy so all other paths reach the function.

Public surface (CDK layer):

| Member | Type | Description |
|--------|------|-------------|
| `fn` | `NodejsFunction` | The function backing this compute. |
| `apiGateway` | `RestApi` | The REST API fronting `fn`. |
| `setEnv(key, value)` | `void` | Inject a runtime env var onto the function — the `Compute` contract the framework calls instead of `handler.addEnvironment` directly. |

`fn` and `apiGateway` exist only on the CDK layer (they are `aws-cdk-lib`
constructs); `setEnv` is part of the `Compute` contract present in every layer
(a no-op in the non-CDK layers — see below).

## Owner-derived identity

`LambdaCompute` does not take the backend entry path or stack name as a
constructor argument. Both are resolved from the owning `BlocksStack` /
`BlocksBackend` through the `Compute` (→ `Scope`) accessors:

- `backendHandlerPath` → the function's `entry`;
- `backendStackName` → the function's `BLOCKS_STACK_NAME` env var.

`BLOCKS_STACK_NAME` is the token-free identity the runtime rebuilds `fullId`
from, so the physical resource names a block computes at synth match the names
the runtime looks up. Deriving both values from the single owner — never from
the caller — guarantees every compute in an app runs the same backend and
resolves the same resource-name namespace. If they could be passed per compute,
two computes in one app could disagree on either, so owner-derivation removes
that failure mode by construction.

## Conditional-export layers

A Blocks app's backend module is imported in **two phases**: at CDK synth, and
again at request time inside the deployed runtime (the framework ships one
bundle and selects behavior by config, not by shipping different code). A
`new LambdaCompute(...)` line in that module therefore executes in both phases,
so the package resolves a different implementation per phase through conditional
exports:

| Condition | Entry | Role |
|-----------|-------|------|
| `cdk` | `index.cdk.ts` | Provisions the `NodejsFunction` + API Gateway (above). The only layer that touches `aws-cdk-lib`. |
| `aws-runtime` | `index.aws.ts` | An **inert handle**. At runtime the infrastructure already exists and the handler already runs on it, so the compute provisions nothing; it constructs (so the import succeeds and `{ compute }` references resolve) and `setEnv` is a no-op — config is injected at synth. |
| `default` / `types` | `index.mock.ts` | Local dev runs the backend in-process with no Lambda, so it reuses the same inert handle. Also backs the public `types`, so the customer-facing type is the CDK-free `Compute` handle. |
| `browser` | `index.browser.ts` | A stub. The backend module is type-imported by frontends; this keeps `aws-cdk-lib` out of the browser bundle. |

The runtime, mock, and browser layers extend the runtime `Scope` (not the CDK
one), so **only the `cdk` layer ever pulls in `aws-cdk-lib`** — the deployed
function and the browser bundle stay free of CDK. This is the same layering data
blocks use; a compute differs only in that its non-CDK layers carry no
request-time behavior (nothing to persist or serve), so they are inert rather
than SDK-backed.

It is excluded from the customer-facing Building Block catalog
(`scripts/sync-catalog.mjs` + `scripts/gen-block-docs.mjs`) and the vendorize map
(`packages/blocks`): an app author does not select a compute the way they select
`KVStore` or `Database`. It is framework machinery.

## Fit within the multi-compute model

`LambdaCompute` is the Lambda implementation of the compute abstraction and the
framework's default compute. It slots into the broader model as follows:

- **Default compute.** Core builds a stack/backend's default compute through a
  registered factory — a hook mirroring client-middleware registration. This
  package supplies `LambdaCompute` as that factory via a side-effect `register`
  module that `@aws-blocks/blocks` imports, so every app gets a Lambda-backed
  default with no explicit wiring while core never imports the concrete class.
- **Compute resolution.** `Scope.compute` resolves the compute a handler runs
  on: an explicit assignment on the block or an ancestor scope, else the app's
  default compute.
- **Resource ownership.** The default compute owns the Lambda function and API
  Gateway that back a stack's `handler` / `gateway` / `apiUrl`; those stack
  accessors delegate to it.
- **Other compute types.** Sibling packages provide container and
  customer-owned `Compute` implementations; event blocks that need
  compute-specific delivery narrow on the concrete type.

The broader multi-compute model also covers request routing across computes,
per-compute event delivery, the IAM and trust model, and VPC networking — none
of which live in this package.
