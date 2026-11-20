# @aws-cdk-blocks/bb-compute

## 1.0.0

The first stable release. The changes since 1.0.0-rc.1 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0 and 1.0.0-rc.1.

### Changes since `@aws-blocks/bb-compute` 0.x

- The package is now `@aws-cdk-blocks/bb-compute`. Install it in place of `@aws-blocks/bb-compute`, and change the import specifiers.

### Since 1.0.0-rc.1

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.1

### Patch Changes

- 0b422ee: The docs state that `scaling.strategy` takes signal objects such as `{ on: 'cpu', targetPercent }`, not names. The README holds the options, defaults, and scaling rules of every compute type.

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

### Patch Changes

- d01c34c: Adds API Extractor reports, `API.md`, for `@aws-cdk-blocks/hosting`, `@aws-cdk-blocks/pipeline`, and `@aws-cdk-blocks/bb-compute`. The block docs folder of `aws-cdk-blocks` ships them next to each package's README.
- 550ed68: The docs state what API namespace placement guarantees. Without `defaults.strictNamespacePlacement`, the bare `POST /cdk-blocks/api` endpoint still runs any namespace on the default compute.

- 1de6ea4: **Breaking: the framework's reserved URL prefix is now `/cdk-blocks/`, and the old `/aws-blocks/` prefix stays served as an alias.**

  To upgrade:

  1. If an external identity provider only allows the `/aws-blocks/auth/callback` redirect URI, register `/cdk-blocks/auth/callback` or set `redirects.callbackPath: '/aws-blocks/auth/callback'`.
  2. If a custom front door or an explicit `apiPaths` routes `/aws-blocks/*` by hand, also route `/cdk-blocks/*` or use `cf.apiBehaviors(origins.api)`.
  3. If the app is at the CloudFront cache-behavior quota, 25 by default, free a behavior or raise the quota, because the built-in front door adds one for `/aws-blocks/*`.

  A sandbox `stubIdp()` issuer moves to `/cdk-blocks/auth/idp/<id>`, so its users get a new `userId`.

- f133ff8: On the `apiFrontDoor: 'cloudfront'` tier, CloudFront routes a `container` API namespace straight to the container's load balancer, so a call can run up to 60 seconds instead of ~29. Those calls skip the gateway's throttling and access logs, and synth warns when the distribution has no web ACL.
- 9ebf67a: An `ApiNamespace` can run on a `container` compute, and clients call it as before. A container that serves API namespaces needs a running task, so `scaling.minInstances: 0` fails synth, and `runContainer()` takes the backend module as `runContainer({ backend })`.
- 76fd75c: The container compute's default image, `public.ecr.aws/docker/library/node:24-slim`, is pinned by digest, so every task start pulls the same image. A custom `image` is still used exactly as written.
- 3ae8592: A deploy no longer resets the task count of an autoscaled container `Compute` to `minInstances`. A job that is running when its task is stopped gets up to 120 seconds to finish, up from 25 seconds.
- e5822ed: A container compute on the default image runs as the image's unprivileged `node` user instead of root, boots from `/home/node/app`, and starts in `/home/node`. Write scratch files under `/tmp`, or set `image` explicitly to the stock Node image if your app needs root.
- 3ae8592: A container `Compute` with `scaling: { minInstances: 0 }` starts a task when a job is waiting. Scaling to zero requires at least one `AsyncJob` or `CronJob` on the compute and the default or `queue-depth` scaling strategy, otherwise synth fails.
- 44c7377: Adds `defaults.strictNamespacePlacement`, which is `false` in both presets. Set `strictNamespacePlacement: true` so each compute serves only the namespaces placed on it, and a call to a namespace placed elsewhere gets a `-32601` "method not found" error.
- c607deb: Behind a Blocks CloudFront front door, a Lambda handler's `ctx.request.url` is the URL the client called, not the gateway's `execute-api` URL. `getRequestBaseUrl()` is unchanged, and each CloudFront door adds one CloudFront Function to the account.
- 8a5726c: Test-only change that checks `defaults.permissionsBoundary` coverage for Auth, Compute, ContainerCompute, CronJob, and Dashboard. No runtime or synth behavior changes.

## 0.2.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.
- ce5dfa9: Adds the `Compute` Building Block, `new Compute(scope, id, { type, ...options })`, where the type is `serverless` or `container`. `AsyncJob({ compute })` runs a job on a container on AWS Fargate, and Blocks provisions one shared VPC per backend for containers.

### Patch Changes

- 0765f84: Adds an optional fourth argument `{ compute }` to `ApiNamespace` that runs the namespace's methods on a `Compute` instead of the app's default compute. Only `serverless` computes can serve API namespaces, and the gateway still caps API calls at about 29 seconds.
- ce5dfa9: Container compute deploys without a local Docker daemon. The task runs a stock public Node image, `public.ecr.aws/docker/library/node:24-slim` by default, so the base image moves from Node 22 to Node 24. An `image` you set is used as is and must provide a Node 24 runtime.
- 8565ef7: Adds a `compute` option to `Scope`, which places everything created under it on one `Compute`, and to `CronJob`, serverless only. A `CronJob` or `AsyncJob` whose compute belongs to a different backend fails synth with an error naming the compute.
- c0f6a83: Include the Apache-2.0 `LICENSE` file in the published package.
