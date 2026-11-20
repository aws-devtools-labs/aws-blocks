# @aws-cdk-blocks/bb-container-compute

The container-backed **compute** for AWS CDK Blocks: an AWS Fargate service (ARM64)
that runs the app's backend as a long-lived process. It self-starts the SQS
pollers for the `AsyncJob`s and `CronJob`s assigned to it, and serves any
`ApiNamespace` routed to it through an internal Application Load Balancer.

> **Internal package.** You don't construct `ContainerCompute` yourself. The
> public `Compute` Building Block (`@aws-cdk-blocks/bb-compute`, re-exported from
> `aws-cdk-blocks`) builds one when you pass `type: 'container'`. Use
> `Compute`, and see the [bb-compute README](../bb-compute/README.md) for usage,
> options and defaults, scaling, image rules and errors.

> Design and rationale: [DESIGN.md](./DESIGN.md)

## API

`ContainerCompute` extends the `Compute` base class from `@aws-cdk-blocks/core`.

| Member | Type | Description |
|--------|------|-------------|
| `type` | `'container'` | Always `'container'`. |
| `vcpu` | `number` | The task's vCPU count, from `size`. |
| `service` | `FargateService \| undefined` | The Fargate service. |
| `taskDefinition` | `FargateTaskDefinition \| undefined` | The task definition. |
| `logGroup` | `LogGroup` | The container's log group. |
| `setEnv(key, value)` | `void` | Inject a runtime environment variable into the container. |
| `ContainerCompute.isContainerCompute(x)` | `boolean` | Type guard that works across duplicate package copies. |

Every member except `setEnv` exists only on the CDK export
(`@aws-cdk-blocks/bb-container-compute/cdk`).

`service` and `taskDefinition` are `undefined` when the backend module path
can't be discovered (for example, in isolated unit tests).

### Options

`ContainerComputeProps` is `size`, `scaling`, `image` and `logRetention`, passed
through from the `Compute` block's `container` options. Types, defaults and
rules: [bb-compute README](../bb-compute/README.md#container).

## Errors

At synth, `src/index.cdk.ts` throws errors for invalid container configurations
and adds the `@aws-cdk-blocks/bb-container-compute:api-rule-quota` warning as
an annotation on the shared listener. The [bb-compute README](../bb-compute/README.md#errors)
lists these checks alongside the namespace placement errors and warnings from core.

## What it provisions (AWS)

- A Fargate task definition and service (ARM64), sized from `size`, using the
  shared CDK Blocks execution role as its task role.
- A CloudWatch log group for the container's stdout/stderr.
- Application Auto Scaling from `scaling` (CPU, memory, or queue-depth policies).
- On demand, when a namespace is routed to it: a target group on the backend's
  shared internal Application Load Balancer, reached by API Gateway through a
  VPC link and, on the `apiFrontDoor: 'cloudfront'` tier, by the API's
  CloudFront distribution through a VPC origin.

## Container image and boot

- The app code is bundled with esbuild and uploaded as an S3 asset. At every
  task start a bootstrap script (`src/bootstrap.mjs`) fetches it with the task
  role and starts it.
- The default image reference is `DEFAULT_CONTAINER_IMAGE` in
  `src/default-image.ts` (`public.ecr.aws/docker/library/node@sha256:…`).
- The image's default user is root. For the default image, the task
  definition's container `user` is `1000:1000`, the working directory is
  `/home/node` and the app boots from `/home/node/app`, which that user owns.
- For a custom `image`, CDK Blocks sets no container `user` or working directory,
  and the app boots from `/app`.
- The API (8080) and readiness (8081) ports aren't privileged, so nothing
  needs root.

## Local development

| Layer | Behavior |
|-------|----------|
| Local dev (mock) | Inert handle: constructs, `setEnv` is a no-op. Handlers assigned to the container run in-process, as on the default compute, so `size` and `scaling` have no effect. The mock refuses to load in a deployed environment. |
| CDK (synth) | Provisions the Fargate service, log group, autoscaling and, when needed, the load balancer target group. |
| AWS runtime | Inert handle. The handler already runs inside the container; configuration was injected at synth. |
| Browser | Stub, so a frontend that type-imports the backend module doesn't pull in CDK. |

## See also

- [DESIGN.md](./DESIGN.md): provisioning, API traffic, autoscaling and runtime details
- [bb-compute README](../bb-compute/README.md): the public `Compute` block
- [bb-async-job README](../bb-async-job/README.md): running jobs on a container
- [bb-lambda-compute README](../bb-lambda-compute/README.md): the serverless counterpart
