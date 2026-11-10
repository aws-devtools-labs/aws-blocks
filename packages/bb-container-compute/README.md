# @aws-blocks/bb-container-compute

The container-backed **compute** for AWS Blocks: an AWS Fargate service (ARM64)
that runs the app's backend as a long-lived process. It self-starts the SQS
pollers for the `AsyncJob`s and `CronJob`s assigned to it, and serves any
`ApiNamespace` routed to it through an internal Application Load Balancer.

> **Internal package.** You don't construct `ContainerCompute` yourself. The
> public `Compute` Building Block (`@aws-blocks/bb-compute`, re-exported from
> `@aws-blocks/blocks`) builds one when you pass `type: 'container'`. Use
> `Compute`, and see the [bb-compute README](../bb-compute/README.md) for the
> customer-facing options.

> Design and rationale: [DESIGN.md](./DESIGN.md)

## Installation

You get this package through `@aws-blocks/blocks`, which depends on it:

```bash
npm install @aws-blocks/blocks
```

## Quick start

Ask for a container through `Compute`, then hand it to a workload:

```ts
import { AsyncJob, Compute, Scope } from '@aws-blocks/blocks';

const scope = new Scope('my-app');

// Backed by a ContainerCompute (Fargate).
const worker = new Compute(scope, 'worker', {
  type: 'container',
  size: { vcpu: 1, memory: 2048 },
  scaling: { minInstances: 1, maxInstances: 10 },
});

new AsyncJob(scope, 'reports', {
  compute: worker,
  timeoutSeconds: 60 * 30, // enforced: the job's worker thread is terminated at the deadline
  handler: async (payload: { month: string }) => {
    /* long-running work */
  },
});
```

## When to use

- Background work that outgrows a serverless function: jobs that run longer
  than 15 minutes, need more memory, or need system libraries in the image.
- An `ApiNamespace` that should run on always-warm tasks with its own CPU,
  memory and scaling.

## When not to use

- Short request/response work with spiky traffic: the default `serverless`
  compute (Lambda) has no idle cost.
- API calls that need more than ~29 seconds through the shared API Gateway
  (its integration timeout), or more than 60 seconds on the
  `apiFrontDoor: 'cloudfront'` tier, where CloudFront reaches a container
  namespace directly. Run that work in an `AsyncJob`.
- As a security boundary: every compute runs the same backend bundle under the
  app's one execution role.

## What it provides

`ContainerCompute` extends the `Compute` base class from `@aws-blocks/core`. At
synth it provisions:

- A Fargate task definition and service (ARM64), sized from `size`, using the
  shared Blocks execution role as its task role.
- A CloudWatch log group for the container's stdout/stderr.
- Application Auto Scaling from `scaling` (CPU, memory, or queue-depth policies).
- On demand, when a namespace is routed to it: a target group on the backend's
  shared internal Application Load Balancer, reached by API Gateway through a
  VPC link and, on the `apiFrontDoor: 'cloudfront'` tier, by the API's
  CloudFront distribution through a VPC origin.

The tasks run in the app's VPC (the one you provide via `defaults.vpc.network`,
or the shared Blocks VPC), in the private-with-egress subnets by default (or
the `defaults.vpc.subnets` you choose).

| Member | Type | Description |
|--------|------|-------------|
| `type` | `'container'` | Always `'container'` (CDK layer). |
| `vcpu` | `number` | The task's vCPU count, from `size` (CDK layer). |
| `service` | `FargateService \| undefined` | The Fargate service (CDK layer). |
| `taskDefinition` | `FargateTaskDefinition \| undefined` | The task definition (CDK layer). |
| `logGroup` | `LogGroup` | The container's log group (CDK layer). |
| `setEnv(key, value)` | `void` | Inject a runtime environment variable into the container. |
| `ContainerCompute.isContainerCompute(x)` | `boolean` | Type guard that works across duplicate package copies (CDK layer). |

Every member except `setEnv` exists only on the CDK export
(`@aws-blocks/bb-container-compute/cdk`).

`service` and `taskDefinition` are `undefined` when the backend module path
can't be discovered (for example, in isolated unit tests).

## Configuration

`ContainerComputeProps`, passed through from the `Compute` block's `container`
options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `size` | `ContainerSize` | `{ vcpu: 0.5, memory: 1024 }` | A valid Fargate vCPU and memory pair. Invalid pairs don't type-check. |
| `scaling` | `ContainerScaling` | fixed at one task | `{ minInstances, maxInstances, strategy? }`. `strategy` is one or more `cpu`, `memory` or `queue-depth` signals; omitted, it's inferred (queue depth for a compute that drains queues, CPU otherwise, and both when it drains queues and serves an `ApiNamespace`: CPU scales it in, the queue backlog only adds tasks). |
| `image` | `string` | `public.ecr.aws/docker/library/node:24-slim`, pinned by digest, run as a non-root user | Public or ECR image URI, pulled verbatim. It must be arm64-compatible and provide Node 24 on `PATH`. Pin it by digest (see [Container image](#container-image)). A custom image runs as its own default user. |
| `logRetention` | `RetentionDays` | the stack's `defaults.logRetention` | How long the container's logs are kept. |

Blocks builds no container image, so deploying needs no local Docker. Your code
is bundled with esbuild and uploaded as an S3 asset; at every task start a small
bootstrap script fetches it with the task role and starts it. A custom `image`
only supplies the runtime environment.

### Container image

ECS pulls the image again at every task start, and the container runs with the
stack's shared execution role. A tag such as `my-image:24` can point at
different bytes on each start, so pin the image by digest. Use the
`repository@sha256:<digest>` form, which ECS documents (it lists `:tag` or
`@digest`, not both), and keep the tag in a comment:

```ts
new Compute(scope, 'worker', {
  type: 'container',
  image: 'public.ecr.aws/my-registry/my-image@sha256:<64-hex digest>', // my-image:24
});
```

Get the digest of a multi-arch image with
`docker buildx imagetools inspect <image>:<tag>` (the `Digest:` line) or
`crane digest <image>:<tag>`. Blocks uses your `image` exactly as written: it
doesn't add a digest to it or change its user.

The default image is ECR Public's mirror of the Docker official
`node:24-slim` image, pinned by digest:
`public.ecr.aws/docker/library/node@sha256:…` (the full reference is
`DEFAULT_CONTAINER_IMAGE` in `src/default-image.ts`). It doesn't change
between deploys until a Blocks release bumps the digest.

The image's default user is root, but Blocks runs the default image as its
unprivileged `node` user (uid/gid 1000; the task definition's container `user`
is `1000:1000`). The app boots from `/home/node/app`, which that user owns. The
API (8080) and readiness (8081) ports aren't privileged, so nothing needs root.
As in Lambda, write scratch files under `/tmp`.

A custom `image` runs as the image's own default user (Blocks sets no container
`user` for it) and boots from `/app`, as before. If your app needs root, for
example to install packages at boot, set `image` explicitly; passing the stock
Node image runs it as root:

```ts
new Compute(scope, 'worker', {
  type: 'container',
  image: 'public.ecr.aws/docker/library/node@sha256:<64-hex digest>', // node:24-slim, runs as root
});
```

`scaling.minInstances: 0` scales the service to zero between jobs. It needs at
least one `AsyncJob` or `CronJob` on the compute and the default (or
`queue-depth`) strategy, and can't be used on a compute that serves an
`ApiNamespace`. Waking from zero usually takes a few minutes, and up to about
20 minutes when the job's queue has been idle for more than six hours.

## Local development vs AWS

| Layer | Behavior |
|-------|----------|
| Local dev (mock) | Inert handle: constructs, `setEnv` is a no-op. Handlers assigned to the container run in-process, as on the default compute, so `size` and `scaling` have no effect. The mock refuses to load in a deployed environment. |
| CDK (synth) | Provisions the Fargate service, log group, autoscaling and, when needed, the load balancer target group. |
| AWS runtime | Inert handle. The handler already runs inside the container; configuration was injected at synth. |
| Browser | Stub, so a frontend that type-imports the backend module doesn't pull in CDK. |

## Errors

All checks run at synth (`cdk synth` / deploy) and throw an `Error` that names
the compute or the namespace path at fault:

- `scaling.minInstances` is not an integer of 0 or more, `scaling.maxInstances`
  is not an integer of 1 or more, or `minInstances` exceeds `maxInstances`.
- `scaling.minInstances: 0` on a compute with no `AsyncJob` or `CronJob`, or
  with a `cpu`/`memory` strategy.
- `scaling.minInstances: 0` on a compute that serves an `ApiNamespace`.
- A namespace path longer than 128 characters (an export name over 112
  characters), or two namespace paths that map to the same load balancer rule
  priority. Rename the export.

Synth warns (`@aws-blocks/bb-container-compute:api-rule-quota`) when more than
100 container API namespaces share one load balancer, its default listener-rule
quota.

## Links

- [DESIGN.md](./DESIGN.md): provisioning, API traffic, autoscaling and runtime details
- [bb-compute README](../bb-compute/README.md): the public `Compute` block
- [bb-async-job README](../bb-async-job/README.md): running jobs on a container
- [bb-lambda-compute README](../bb-lambda-compute/README.md): the serverless counterpart
