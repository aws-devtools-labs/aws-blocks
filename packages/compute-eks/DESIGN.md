# Design: @aws-blocks/compute-eks

Shares the hybrid companion-Lambda model, shared execution role, and
CloudFront front-door reasoning with `@aws-blocks/compute-ecs` (see its
DESIGN.md). This file covers what is EKS-specific.

## Auto Mode on aws-eks-v2

`EksCompute` builds on `aws-cdk-lib/aws-eks-v2`, the stabilized successor to
the custom-resource-based `aws-eks` module (the alpha package carries the
notice "This package has been stabilized and moved to aws-cdk-lib"). It
renders a native `AWS::EKS::Cluster`, uses access entries (API
authentication mode), and defaults the capacity type to Auto Mode: compute
(`system` + `general-purpose` node pools), block storage, and load balancing
capabilities all enabled, with the node role, its access entry, and the Auto
Mode cluster-role policies managed by the construct. The kubectl provider is
opt-in (`kubectlProviderOptions`) and is only used for the two manifests and
the ingress-hostname read; its handler role automatically receives a
cluster-admin access entry. A unit test pins the rendered Auto Mode cluster
properties.

Auto Mode discovers load-balancer subnets by role tags, so the construct
tags the VPC's public subnets with `kubernetes.io/role/elb=1` and private
subnets with `kubernetes.io/role/internal-elb=1` (verified live: without the
tags the Ingress never gets an ALB).

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
header. The value lives in Secrets Manager and is read at deploy time by an
`AwsCustomResource` (`GetSecretValue`) that feeds both the ingress annotation
and the CloudFront custom header, so the two always match. A
`{{resolve:secretsmanager:...}}` dynamic reference cannot be used here:
CloudFormation does not substitute dynamic references inside custom resource
properties, so the kubectl provider would apply the literal `{{resolve:...}}`
string and the controller's `CreateRule` call fails on the 128-character
condition-value limit (verified live; a unit test pins that manifests contain
no dynamic references).

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
