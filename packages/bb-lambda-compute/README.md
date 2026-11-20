# @aws-cdk-blocks/bb-lambda-compute

The Lambda-backed **compute** for AWS CDK Blocks: a `NodejsFunction` that backs the
handler code an app's Building Blocks run on. The stack's single shared API
Gateway REST API (provisioned by core) integrates this compute's function; there
is no per-compute gateway.

> **Framework machinery — don't depend on it directly.** `LambdaCompute` is not
> re-exported from `aws-cdk-blocks`. It reaches an app two ways:
>
> - **As the default compute.** `BlocksStack` / `BlocksBackend` from
>   `aws-cdk-blocks` build one `LambdaCompute` for every app; handlers that
>   don't name a compute run on it.
> - **Through the `Compute` block.** `new Compute(scope, id, { type: 'serverless', … })`
>   from `aws-cdk-blocks` creates and owns a `LambdaCompute`. See the
>   [bb-compute README](../bb-compute/README.md) for usage, options and defaults.

> Design and rationale: [DESIGN.md](./DESIGN.md)

## API

`LambdaCompute` is a `Compute` (the abstract base from `@aws-cdk-blocks/core`) that
provisions and owns a `NodejsFunction` and its CloudWatch log group. The
function assumes the shared CDK Blocks execution role, so Building Block grants
reach it. Its handler entry and `BLOCKS_STACK_NAME` are derived from the owning
`BlocksStack` / `BlocksBackend`, never caller-supplied.

| Member | Type | Description |
|--------|------|-------------|
| `fn` | `NodejsFunction` | The Lambda function backing this compute (CDK layer). |
| `logGroup` | `LogGroup` | The function's CloudWatch log group (CDK layer). |
| `apiHandler()` | `IFunction` | The function the stack's shared REST API gateway integrates (returns `fn`). |
| `setEnv(key, value)` | `void` | Inject a runtime environment variable into the function. A no-op outside the CDK layer. |
| `LambdaCompute.isLambdaCompute(x)` | `x is LambdaCompute` | Type guard that also works when two copies of this package are installed (CDK layer). |

### Options

`Compute` passes its `memory`, `maxTimeoutSeconds`, and `logRetention` through
to `LambdaComputeProps`. Types and defaults:
[bb-compute README](../bb-compute/README.md#serverless). One option is not
exposed through the `Compute` block:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `architecture` | `Architecture` | `ARM_64` | Instruction set (Graviton by default). |

## Behavior

- **VPC.** When the stack sets `defaults.vpc`, the function is placed in that
  VPC's compute subnets (`defaults.vpc.subnets`, private-with-egress by default)
  with the shared compute security group. With no VPC context it runs in the
  AWS-managed network. A VPC that CDK Blocks creates for a container compute does
  not contain the default compute. A serverless `Compute` declared after the
  container compute is placed in it.
- **CORS.** When the stack's `defaults.allowedOrigins` is non-empty (e.g. the
  sandbox preset allows localhost), the entries (plain origins, matched
  exactly, or regex patterns) are set on the function as `CORS_ALLOWED_ORIGINS`.
- **Tracing.** When a `Tracer` is registered, the function switches to X-Ray
  Active tracing.
- **Dashboard.** Contributes health (invocations, errors, duration, concurrent
  executions), logging (recent errors, log volume), and — with a `Tracer` —
  trace widgets to `bb-dashboard`.

## Local development

Only the `cdk` layer provisions infrastructure. The runtime, local-dev and
browser layers are inert handles that construct without pulling in CDK. In
local dev, handlers run in-process, and `memory` and `maxTimeoutSeconds` have
no effect.
The CDK tests (`src/index.cdk.test.ts`) show how `LambdaCompute` synthesizes
within a stack.
