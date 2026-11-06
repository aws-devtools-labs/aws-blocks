# @aws-blocks/bb-lambda-compute

The Lambda-backed **compute** for AWS Blocks: a `NodejsFunction` that backs the
handler code an app's Building Blocks run on. The stack's single shared API
Gateway REST API (provisioned by core) integrates this compute's function — not
a per-compute gateway.

> **Framework machinery — don't depend on it directly.** `LambdaCompute` is not
> re-exported from `@aws-blocks/blocks`. It reaches an app two ways:
>
> - **As the default compute.** `BlocksStack` / `BlocksBackend` from
>   `@aws-blocks/blocks` build one `LambdaCompute` for every app; handlers that
>   don't name a compute run on it.
> - **Through the `Compute` block.** `new Compute(scope, id, { type: 'serverless', … })`
>   from `@aws-blocks/blocks` creates and owns a `LambdaCompute`. See the
>   [`Compute` README](https://github.com/aws-devtools-labs/aws-blocks/tree/main/packages/bb-compute#readme).

> Design and rationale: [DESIGN.md](./DESIGN.md)

## What it provides

`LambdaCompute` — a `Compute` (the abstract base from `@aws-blocks/core`) that
provisions and owns a `NodejsFunction` and its CloudWatch log group. The stack's
shared REST API fronts it (via `apiHandler()`). The function assumes the
shared Blocks execution role, so Building Block grants reach it; its handler
entry and `BLOCKS_STACK_NAME` are derived from the owning `BlocksStack` /
`BlocksBackend`, never caller-supplied.

| Member | Type | Description |
|--------|------|-------------|
| `fn` | `NodejsFunction` | The Lambda function backing this compute (CDK layer). |
| `logGroup` | `LogGroup` | The function's CloudWatch log group (CDK layer). |
| `apiHandler()` | `IFunction` | The function the stack's shared REST API gateway integrates (returns `fn`). |
| `setEnv(key, value)` | `void` | Inject a runtime environment variable into the function. A no-op outside the CDK layer. |
| `LambdaCompute.isLambdaCompute(x)` | `x is LambdaCompute` | Type guard that also works when two copies of this package are installed (CDK layer). |

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `memory` | `number` | `2048` | Function memory in MB. CPU scales with memory. |
| `maxTimeoutSeconds` | `number` | `900` | Function timeout (1–900). Bounds async work (`AsyncJob`, queues); the synchronous API path is cut off at the shared gateway's 29s integration timeout regardless. |
| `logRetention` | `RetentionDays` | stack `defaults.logRetention` | How long the handler log group keeps logs. |
| `architecture` | `Architecture` | `ARM_64` | Instruction set (Graviton by default). Not exposed through the `Compute` block. |

`Compute` passes its `memory`, `maxTimeoutSeconds`, and `logRetention` through
to these options.

## Behavior

- **VPC.** When the stack sets `defaults.vpc`, the function is placed in that
  VPC's compute subnets (`defaults.vpc.subnets`, private-with-egress by default)
  with the shared compute security group. With no VPC context it runs in the
  AWS-managed network. A VPC that Blocks derives on its own (for a container
  compute) does not move the default compute, which is built before that VPC
  exists; a serverless `Compute` declared after the container compute does land in it.
- **CORS.** When the stack's `defaults.allowedOrigins` is non-empty (e.g. the
  sandbox preset allows localhost), the origin patterns (regular expressions)
  are set on the function as `CORS_ALLOWED_ORIGINS`.
- **Tracing.** When a `Tracer` is registered, the function switches to X-Ray
  Active tracing.
- **Dashboard.** Contributes health (invocations, errors, duration, concurrent
  executions), logging (recent errors, log volume), and — with a `Tracer` —
  trace widgets to `bb-dashboard`.

## Local Development

Only the `cdk` layer provisions infrastructure; the runtime, local-dev, and
browser layers are inert handles that construct without pulling in CDK, because
a compute has no request-time behavior. See the CDK tests
(`src/index.cdk.test.ts`) for how `LambdaCompute` synthesizes within a stack.
