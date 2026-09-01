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
- **A CloudWatch log group** for the function (`logGroup`), passed as the
  function's `logGroup` so its retention follows the stack-wide
  `defaults.logRetention` instead of AWS's infinite default. It is a single
  framework-owned group (not a second `/aws/lambda/<fn>` group), so `bb-logger`
  reconfigures it and `bb-dashboard` reads its name via `scope.handlerLogGroup`.
  Named `logGroup` (not `handlerLogGroup`) to avoid clashing with the inherited
  `Scope.handlerLogGroup` accessor. `RemovalPolicy.DESTROY` — the handler's
  operational stdout is not durable state.
- **An API Gateway REST API** fronting the function:
  - the `/aws-blocks` resource gets a proxy so `RawRoute` sub-paths reach the
    function;
  - `/aws-blocks/api` gets explicit `POST` + `OPTIONS` methods (the JSON-RPC
    endpoint);
  - the root gets a catch-all proxy so all other paths reach the function.
  - **Throttling** — the stage's method throttle comes from `defaults.throttling`
    (sandbox 200/400, production 1000/2000).
  - **Access logging** — when `defaults.accessLogging` is true (production
    preset), the stage writes structured JSON access logs to a dedicated
    CloudWatch log group (retention = `defaults.logRetention`, removal policy =
    `defaults.removalPolicy` — production RETAINs the audit trail on teardown,
    sandbox DESTROYs). `cloudWatchRole` is disabled on the `RestApi` so it does
    not mint its own `AWS::ApiGateway::Account`; instead the shared account-level
    CloudWatch Logs role is provisioned once per stack via
    `ensureApiGatewayAccount()`, and the stage depends on it so a clean-account
    first deploy applies the account setting before the stage is created.
    Note: a production (RETAINed) access-log group is **orphaned** on stack
    teardown and is the operator's to clean up. The group is intentionally left
    unnamed (CDK-generated physical name) so a teardown-then-redeploy mints a
    fresh name and can't collide — do not pin a stable `logGroupName`, or a
    RETAINed group from a prior delete would fail the next create.

Public surface (CDK layer):

| Member | Type | Description |
|--------|------|-------------|
| `fn` | `NodejsFunction` | The function backing this compute. |
| `apiGateway` | `RestApi` | The REST API fronting `fn`. |
| `logGroup` | `LogGroup` | The function's CloudWatch log group (retention from `defaults.logRetention`). |
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

- **Default compute.** `LambdaCompute` is the framework's default compute,
  injected so core can build it without importing the concrete class — see
  [How the default compute is injected](#how-the-default-compute-is-injected).
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

## How the default compute is injected

Core must obtain a `LambdaCompute` **without importing it**. The dependency
arrow only points one way — `@aws-blocks/bb-lambda-compute` depends on
`@aws-blocks/core`, never the reverse — because the reverse would be a cycle and
would drag the concrete CDK class (and `aws-cdk-lib`) into core. So core defines
the seam (a factory *type* and a required props field), and the umbrella
`@aws-blocks/blocks` — the one package that depends on both core and this one —
supplies a concrete factory through a normal `import`.

### The three participants

- **Core owns the seam** (`packages/core/src/cdk/compute/default-compute-factory.ts`,
  exposed via `@aws-blocks/core/cdk/internal`): just the factory *type*.

  ```ts
  export type DefaultComputeFactory = (root: BlocksStack | BlocksBackend) => Compute;
  ```

  `create()` reads the factory from its **props** — core defines
  `CoreBlocksStackProps` / `CoreBlocksBackendProps` (the public
  `BlocksStackProps` / `BlocksBackendProps` plus a required
  `defaultComputeFactory`) — and calls it to build the default:

  ```ts
  export interface CoreBlocksStackProps extends BlocksStackProps {
    defaultComputeFactory: DefaultComputeFactory;
  }

  static async create(scope, id, props: CoreBlocksStackProps) {
    ...
    stack._defaultCompute = props.defaultComputeFactory(stack);   // before the backend import
  }
  ```

  The factory rides on the props but **not the customer-facing type** — it lives
  on `CoreBlocksStackProps`, absent from the public `BlocksStackProps`, so a
  bare-`@aws-blocks/core` caller who omits it gets a compile error, not a runtime
  one. Because it is required, core needs no runtime "no factory" guard.

- **The umbrella supplies the factory** (`@aws-blocks/blocks`, `index.cdk.ts`) —
  a plain import of the concrete class, and a thin wrapper around `create()` that
  injects it:

  ```ts
  import { BlocksStack as CoreBlocksStack } from '@aws-blocks/core/cdk';
  import { LambdaCompute } from '@aws-blocks/bb-lambda-compute';

  const lambdaDefaultComputeFactory = (root) => new LambdaCompute(root, 'DefaultCompute');

  export const BlocksStack = {
    create: (scope, id, props) =>
      CoreBlocksStack.create(scope, id, { ...props, defaultComputeFactory: lambdaDefaultComputeFactory }),
  };
  export type BlocksStack = CoreBlocksStack;   // instance type unchanged
  ```

  The umbrella's wrapper accepts only the public `(scope, id, props)`, so a
  customer can't set the factory through it.

  The `import` is a real, visible edge (`@aws-blocks/blocks` → this package) that
  the module graph, bundler, and `lint:deps` all see — not a load-bearing
  side-effect import.

- **The customer calls the umbrella's wrapper.** Every app already does
  `import { BlocksStack } from '@aws-blocks/blocks/cdk'`, so the call site is
  unchanged (`BlocksStack.create(app, id, { backendHandlerPath, backendCDKPath })`);
  the factory is injected for them.

### Execution order (CDK synth)

1. The app calls the umbrella's `BlocksStack.create(...)` / `BlocksBackend.create(...)`.
2. The wrapper forwards to core's `create()`, spreading the factory onto the
   props (public `BlocksStackProps` → `CoreBlocksStackProps`).
3. Inside core's `create()`, `this._defaultCompute = props.defaultComputeFactory(this)`
   runs **before** importing the backend module — so a block that reads
   `this.compute` in its constructor (during that import) resolves to it. That
   call runs `new LambdaCompute(root, 'DefaultCompute')`, provisioning the
   function + API Gateway.
4. `Scope.compute` and the delegating `handler` / `gateway` / `apiUrl` accessors
   read from `_defaultCompute`.

A bare-`@aws-blocks/core` caller must supply `defaultComputeFactory` on the props
(it is required); any app using `@aws-blocks/blocks` gets it injected for free.

The `DefaultComputeFactory` type stays on `@aws-blocks/core/cdk/internal`; none
of this is public, customer-facing surface.
