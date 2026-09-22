# @aws-blocks/bb-lambda-compute

The Lambda-backed **compute** for AWS Blocks: a `NodejsFunction` fronted by its
own API Gateway REST API, backing the handler code an app's Building Blocks run
on.

> **Internal / not yet customer-facing.** `LambdaCompute` is not re-exported
> from the public `@aws-blocks/blocks` surface, and nothing in the default app
> path constructs it. This package ships the compute type and its infrastructure
> so later work can build on it. Do not depend on it directly.

> Design and rationale: [DESIGN.md](./DESIGN.md)

## What it provides

`LambdaCompute` — a `Compute` (the abstract base from `@aws-blocks/core`) that
provisions and owns a `NodejsFunction` (2048 MB, 15-minute timeout) fronted by
its own API Gateway REST API. The function assumes the shared Blocks execution
role, so Building Block grants reach it; its handler entry and `BLOCKS_STACK_NAME`
are derived from the owning `BlocksStack` / `BlocksBackend`, never
caller-supplied.

| Member | Type | Description |
|--------|------|-------------|
| `fn` | `NodejsFunction` | The Lambda function backing this compute (CDK layer). |
| `apiGateway` | `RestApi` | The API Gateway REST API fronting `fn` (CDK layer). |
| `setEnv(key, value)` | `void` | Inject a runtime environment variable into the function. |

## Local Development

Only the `cdk` layer provisions infrastructure (the `NodejsFunction` + API
Gateway); the runtime, local-dev, and browser layers are inert handles that
construct without pulling in CDK, because a compute has no request-time
behavior. See the CDK tests (`src/index.cdk.test.ts`) for how `LambdaCompute`
synthesizes within a stack.
