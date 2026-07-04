# Design: @aws-blocks/compute-eks

Shares the hybrid companion-Lambda model, shared execution role, and
CloudFront front-door reasoning with `@aws-blocks/compute-ecs` (see its
DESIGN.md). This file covers what is EKS-specific.

## Auto Mode on the stable aws-eks module

The stable `aws-cdk-lib/aws-eks` L2 does not model Auto Mode (only the alpha
`@aws-cdk/aws-eks-v2-alpha` does, and an alpha dependency is not acceptable
in a framework package). `EksCompute` therefore enables Auto Mode through the
documented cluster settings, applied to the L2's cluster custom resource
(`Config.*`, camelCase, passed to the EKS CreateCluster API):

- `computeConfig`: enabled, `system` + `general-purpose` node pools, a node
  role with `AmazonEKSWorkerNodeMinimalPolicy` + `AmazonEC2ContainerRegistryPullOnly`
- `storageConfig.blockStorage` and `kubernetesNetworkConfig.elasticLoadBalancing` enabled
- `bootstrapSelfManagedAddons: false` (Auto Mode replaces CoreDNS, kube-proxy, VPC CNI)
- cluster role gains the four Auto Mode managed policies and `sts:TagSession` trust
- an `EC2_AUTO` access entry admits the node role

All of it is contained in one private method so migrating to a native L2
(when `aws-eks-v2` stabilizes) is mechanical. A unit test pins the rendered
cluster config.

## Identity: Pod Identity, not IRSA

The seam's shared role is one role trusted by multiple principals. Pod
Identity fits that directly: `pods.eks.amazonaws.com` joins the trust policy
(with `sts:TagSession`) and one `AWS::EKS::PodIdentityAssociation` maps the
backend service account onto the role. IRSA would need a per-cluster
OIDC-federated trust statement, which fights the composite-principal design.
Auto Mode nodes run the Pod Identity agent out of the box.

## Front door: origin-verify header instead of a VPC origin

Ingress-provisioned ALBs surface only a hostname (no ARN), so a CloudFront
VPC origin cannot be wired to them. The ALB is internet-facing but every
request must carry the `X-Origin-Verify` header — enforced as an ALB listener
rule condition from the ingress `conditions.*` annotation; non-matching
requests hit the default 404. CloudFront adds the header as an origin custom
header. The value is a Secrets Manager dynamic reference, so it is stable
across deploys (no rotation race between the CloudFront update and the ALB
rule update).

## Two manifests, not one

The Deployment's env includes `BLOCKS_PUBLIC_ORIGIN` (the CloudFront domain),
CloudFront's origin reads the ingress ALB hostname (`KubernetesObjectValue`),
and the hostname only exists after the Ingress applies. One manifest holding
both the Ingress and the Deployment would be a dependency cycle. Split:

1. infra manifest — Namespace, ServiceAccount, IngressClass(+Params), Service, Ingress
2. `KubernetesObjectValue` reads the ALB hostname → CloudFront distribution
3. backend manifest — the Deployment (env references the distribution;
   depends on the Pod Identity association and the config BucketDeployment)

Pods therefore roll out only after the config object exists in S3 and the
front door is live.

## Pod environment

Manifests are JSON documents stringified by CDK, so the handler env mirror
uses `handlerEnvironmentForJson` (compute-common): values resolved at synth
inside a `cdk.Lazy`, with intrinsic references re-tokenized via
`Token.asString` so they render as CloudFormation joins inside the manifest
string. Late `addEnvironment` calls (after `BlocksStack.create()` returns)
are captured because the Lazy resolves at synthesis.

## Known limitations / follow-ups

- First deploy is slow (~15-20 min: control plane + kubectl provider nested stack).
- Horizontal Pod Autoscaler needs metrics-server; v1 ships fixed `replicas`.
- Container log shipping (CloudWatch) is a follow-up; `kubectl logs` works.
- Teardown ordering (ingress → ALB → VPC) is handled by the manifest
  dependency chain; verify on real teardown as part of e2e evidence.
