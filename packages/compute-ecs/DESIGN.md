# Design: @aws-blocks/compute-ecs

## The hybrid companion-Lambda model

In container mode the backend Lambda is still created. Containers serve all
HTTP traffic (JSON-RPC + RawRoutes); the Lambda keeps serving event sources:
SQS (`AsyncJob`), EventBridge Scheduler (`CronJob`), API Gateway WebSocket
(`Realtime`), and CloudFormation custom resources (migrations). Both run the
same esbuild bundle built with `--conditions aws-runtime`.

Why not poll SQS inside the containers: Lambda event source mappings provide
batching, retries, partial-batch failure, DLQ wiring and scale-to-zero;
`Realtime` cannot move at all (WebSocket API integrations target Lambda). An
idle Lambda costs nothing.

## One shared execution role

Building Blocks attach IAM and env vars to `Scope.handler` (the Lambda).
Instead of teaching each block about containers, core creates a single role
trusted by `lambda.amazonaws.com` and `ecs-tasks.amazonaws.com`, used as the
Lambda role AND the ECS task role. Every `grant*()` a block makes lands on
both compute shapes, third-party blocks included.

## Environment mirroring

Blocks add env vars to the handler during construction, and app code may add
more after `BlocksStack.create()` returns. A CDK Aspect resolves the
handler's final environment at synthesis and writes it into the container
definition through a property override, so intrinsic references (Ref,
Fn::GetAtt) survive. Container-specific variables (`PORT`, `BLOCKS_COMPUTE`,
`BLOCKS_PUBLIC_ORIGIN`, `BLOCKS_HTTP_TIMEOUT_MS`) take precedence.

## Front door: CloudFront over a VPC origin

The ALB stays internal; CloudFront reaches it through a VPC origin. This
gives HTTPS (Secure cookies, OIDC redirects) with zero certificate setup and
keeps the origin unreachable from the internet. The ALB security group allows
port 80 from the VPC CIDR, which is where CloudFront's VPC-origin ENIs live.
`BLOCKS_PUBLIC_ORIGIN` is injected so absolute URLs built by the backend
(OIDC redirect URIs) use the CloudFront domain, not the internal ALB host.

VPC origins require the origin in **private** subnets: with the ALB in a
public subnet the origin-facing ENIs deploy but traffic black-holes
(verified live: healthy targets, `Deployed` VPC origin, CloudFront 504).
The ALB therefore always gets private subnets — isolated ones in `public`
mode, so that mode stays NAT-free.

Rejected alternatives: a bare ALB URL breaks Secure-cookie auth over HTTP; a
mandatory customer ACM certificate breaks zero-config deploys.

## Boot ordering

Containers load `blocks-config.json` from S3 at startup (same mechanism as
the Lambda cold start). The service depends on the config BucketDeployment so
tasks never boot before the object exists. The ALB health check
(`/aws-blocks/health`) only reports healthy after the backend finished
initializing, giving rolling deploys correct semantics.

## Networking modes

- `private` (default): tasks in private subnets behind one NAT gateway.
- `public` (default in sandbox): tasks in public subnets with public IPs and
  no NAT, trading isolation for cost in dev environments.

## Known limitations / follow-ups

- Docker is required on the deploying machine (CDK image asset).
- A same-VPC RDS Proxy path for `Database` (instead of the Data API) needs a
  VPC/security-group seam on `bb-data` and is a documented follow-up.
- Container-side tracing (`Tracer` uses a Lambda-only escape hatch today) is
  a follow-up; the companion Lambda keeps tracing its event-source work.
