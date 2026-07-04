---
"@aws-blocks/compute-eks": minor
"@aws-blocks/compute-common": patch
---

New package: run the Blocks backend on EKS Auto Mode behind an ALB ingress
with a CloudFront front door via `compute: new EksCompute()`. Pod Identity
maps the backend service account onto the shared execution role.
compute-common gains `handlerEnvironmentForJson` for JSON-embedded env
mirroring (Kubernetes manifests).
