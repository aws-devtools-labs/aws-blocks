# @aws-blocks/compute-ecs

Run your AWS Blocks backend on ECS Fargate, load-balanced behind an internal
ALB with a CloudFront front door, instead of API Gateway + Lambda.

```ts
// aws-blocks/index.cdk.ts
import { EcsFargateCompute } from '@aws-blocks/compute-ecs';

const stack = await BlocksStack.create(app, name, {
  backendHandlerPath,
  backendCDKPath,
  compute: new EcsFargateCompute(),
});
```

That is the whole change. Local development (`npm run dev`) is untouched, and
every Building Block works unchanged: the containers and the companion Lambda
share one execution role, so grants made by blocks apply to both.

## What you get

- ECS Fargate service (2 tasks by default) in a dedicated 2-AZ VPC
- Internal Application Load Balancer with health checks on `/aws-blocks/health`
- CloudFront distribution over a VPC origin: HTTPS by default, `Secure` auth
  cookies and OIDC redirects work with zero certificate setup
- Target-tracking autoscaling (CPU 50%, 500 requests/task, 2 to 10 tasks)
- Deployment circuit breaker with automatic rollback
- The container image is built from your backend at deploy time (requires
  Docker on the deploying machine)
- Event-driven blocks (`AsyncJob`, `CronJob`, `Realtime`) keep running on the
  companion Lambda; HTTP requests are no longer bound by the API Gateway 29s
  limit (55s default, configurable via `requestTimeoutMs`)

## Options

```ts
new EcsFargateCompute({
  vpc,                                  // bring your own VPC
  networkMode: 'private' | 'public',    // default: private (public in sandbox)
  cpu: 512, memoryLimitMiB: 2048,
  desiredCount: 2,
  autoscaling: { minCapacity, maxCapacity, targetCpuPercent, requestsPerTarget },
  domainName, certificate,              // custom domain (ACM cert in us-east-1)
  logRetention,
  requestTimeoutMs: 55_000,
});
```

## Database

The `Database` block works from containers with no changes: it talks to
Aurora through the RDS Data API over HTTPS, and its IAM grant lands on the
shared execution role. External databases (`fromExisting`) are reached over
TLS through the VPC's egress path.

See [DESIGN.md](./DESIGN.md) for architecture details.
