# @aws-cdk-blocks/bb-container-compute

## 1.0.0

The first stable release. The changes since 1.0.0-rc.1 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0 and 1.0.0-rc.1.

### Changes since `@aws-blocks/bb-container-compute` 0.x

- The package is now `@aws-cdk-blocks/bb-container-compute`. Install it in place of `@aws-blocks/bb-container-compute`, and change the import specifiers.
- 9ebf67a: An API namespace can run on a `container` compute.
- e5822ed: A container compute on the default image now runs as the image's unprivileged `node` user (uid/gid 1000) instead of root.
- 3ae8592: Scale a container compute to zero between jobs.

### Since 1.0.0-rc.1

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.1

### Patch Changes

- 0b422ee: The options, defaults, and scaling rules are documented in the `bb-compute` README.

## 1.0.0-rc.0

### Major Changes

- e50b9e9: **Breaking: every published package moves from the `@aws-blocks` scope to `@aws-cdk-blocks`, and `@aws-blocks/blocks` becomes the unscoped `aws-cdk-blocks`.**

  To upgrade:

  1. In `package.json`, replace `@aws-blocks/blocks` with `aws-cdk-blocks` and every other `@aws-blocks/` name with `@aws-cdk-blocks/`, for example `@aws-cdk-blocks/core`.
  2. Make the same replacement in the specifier of every import.
  3. Change each `Annotations.of(stack).acknowledgeWarning('@aws-blocks/…')` call to the `@aws-cdk-blocks/` prefix, or `cdk synth --strict` fails on the warning.
  4. Keep the CDK context key `@aws-blocks/bb-data:encryptStorageByDefault` in `cdk.json` as it is, because renaming it makes CloudFormation replace the cluster.
  5. If you publish a block, move its dependency from `@aws-blocks/core` to `@aws-cdk-blocks/core`.

  No export or option moved, and the old `@aws-blocks/*` packages stop receiving releases.

### Minor Changes

- 9ebf67a: An `ApiNamespace` can run on a `container` compute, and clients call it as before. A container that serves API namespaces needs a running task, so `scaling.minInstances: 0` fails synth, and `runContainer()` takes the backend module as `runContainer({ backend })`.
- e5822ed: A container compute on the default image runs as the image's unprivileged `node` user instead of root, boots from `/home/node/app`, and starts in `/home/node`. Write scratch files under `/tmp`, or set `image` explicitly to the stock Node image if your app needs root.
- 3ae8592: A container `Compute` with `scaling: { minInstances: 0 }` starts a task when a job is waiting. Scaling to zero requires at least one `AsyncJob` or `CronJob` on the compute and the default or `queue-depth` scaling strategy, otherwise synth fails.

### Patch Changes

- 6236bf9: Add a README describing the internal container compute, its options, local-dev and AWS behavior, and synth-time errors.

- 1de6ea4: **Breaking: the framework's reserved URL prefix is now `/cdk-blocks/`, and the old `/aws-blocks/` prefix stays served as an alias.**

  To upgrade:

  1. If an external identity provider only allows the `/aws-blocks/auth/callback` redirect URI, register `/cdk-blocks/auth/callback` or set `redirects.callbackPath: '/aws-blocks/auth/callback'`.
  2. If a custom front door or an explicit `apiPaths` routes `/aws-blocks/*` by hand, also route `/cdk-blocks/*` or use `cf.apiBehaviors(origins.api)`.
  3. If the app is at the CloudFront cache-behavior quota, 25 by default, free a behavior or raise the quota, because the built-in front door adds one for `/aws-blocks/*`.

  A sandbox `stubIdp()` issuer moves to `/cdk-blocks/auth/idp/<id>`, so its users get a new `userId`.

- f133ff8: On the `apiFrontDoor: 'cloudfront'` tier, CloudFront routes a `container` API namespace straight to the container's load balancer, so a call can run up to 60 seconds instead of ~29. Those calls skip the gateway's throttling and access logs, and synth warns when the distribution has no web ACL.
- 76fd75c: The container compute's default image, `public.ecr.aws/docker/library/node:24-slim`, is pinned by digest, so every task start pulls the same image. A custom `image` is still used exactly as written.
- 3ae8592: A deploy no longer resets the task count of an autoscaled container `Compute` to `minInstances`. A job that is running when its task is stopped gets up to 120 seconds to finish, up from 25 seconds.
- 2b250f8: A container compute scopes the `ecs-tasks.amazonaws.com` trust on the shared execution role with `aws:SourceAccount` and `aws:SourceArn`. Only ECS tasks in the stack's own account and region can assume the role.
- c607deb: Behind a Blocks CloudFront front door, a Lambda handler's `ctx.request.url` is the URL the client called, not the gateway's `execute-api` URL. `getRequestBaseUrl()` is unchanged, and each CloudFront door adds one CloudFront Function to the account.
- 8a5726c: Test-only change that checks `defaults.permissionsBoundary` coverage for Auth, Compute, ContainerCompute, CronJob, and Dashboard. No runtime or synth behavior changes.
- 2095f31: `ctx.request.url.pathname` is the route path in every environment and no longer includes the API Gateway stage when deployed. If you build an absolute link from it while clients call the API Gateway URL directly, add the stage yourself or build the link from your app's configured origin.
- 58817b0: The IAM roles AWS Blocks creates scope every service-principal trust to the stack's account with `aws:SourceAccount` and `aws:SourceArn`. Synth warns about a role your app creates without them, and "Service-principal trust" in the `@aws-cdk-blocks/core` README shows how to resolve it.

## 0.2.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.
- ce5dfa9: Adds the `Compute` Building Block, `new Compute(scope, id, { type, ...options })`, where the type is `serverless` or `container`. `AsyncJob({ compute })` runs a job on a container on AWS Fargate, and Blocks provisions one shared VPC per backend for containers.

### Patch Changes

- ce5dfa9: Container compute deploys without a local Docker daemon. The task runs a stock public Node image, `public.ecr.aws/docker/library/node:24-slim` by default, so the base image moves from Node 22 to Node 24. An `image` you set is used as is and must provide a Node 24 runtime.
- c0f6a83: Include the Apache-2.0 `LICENSE` file in the published package.
