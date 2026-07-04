# @aws-blocks/compute-eks

Run your AWS Blocks backend on EKS Auto Mode, load-balanced behind an ALB
ingress with a CloudFront front door, instead of API Gateway + Lambda.

```ts
// aws-blocks/index.cdk.ts
import { EksCompute } from '@aws-blocks/compute-eks';

const stack = await BlocksStack.create(app, name, {
  backendHandlerPath,
  backendCDKPath,
  compute: new EksCompute(),
});
```

That is the whole change. Local development (`npm run dev`) is untouched, and
every Building Block works unchanged: pods assume the shared execution role
through EKS Pod Identity, so grants made by blocks apply to them exactly as
they apply to the companion Lambda.

## What you get

- EKS cluster with **Auto Mode**: AWS manages nodes, autoscaling, and load
  balancing capability — no node groups to operate, no controller installs
- Backend Deployment (2 replicas, spread across AZs) with readiness and
  liveness probes on `/aws-blocks/health`
- ALB provisioned from a standard Ingress by Auto Mode's built-in load
  balancing; direct-to-ALB requests without the CloudFront origin-verify
  header get a 404
- CloudFront front door: HTTPS by default, `Secure` auth cookies and OIDC
  redirects work with zero certificate setup
- Pod Identity mapping the backend service account onto the shared execution
  role (no IRSA, no OIDC provider setup)
- Event-driven blocks (`AsyncJob`, `CronJob`, `Realtime`) keep running on the
  companion Lambda; HTTP requests get a 55s default deadline
  (`requestTimeoutMs`)

## Options

```ts
new EksCompute({
  vpc,                        // bring your own VPC
  kubernetesVersion,          // default: 1.33
  namespace: 'aws-blocks',
  replicas: 2,
  domainName, certificate,    // custom domain (ACM cert in us-east-1)
  requestTimeoutMs: 55_000,
  ingressReadyTimeout,        // how long to wait for the ALB hostname
});
```

## Notes

- First deploy takes ~15-20 minutes (EKS control plane + kubectl provider).
- Docker is required on the deploying machine to build the backend image.
- The `Database` block works from pods with no changes (RDS Data API over
  HTTPS; the grant lands on the shared role via Pod Identity).

See [DESIGN.md](./DESIGN.md) for architecture details.
