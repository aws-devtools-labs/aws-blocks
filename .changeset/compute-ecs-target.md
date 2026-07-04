---
"@aws-blocks/compute-common": minor
"@aws-blocks/compute-ecs": minor
---

New packages: run the Blocks backend on ECS Fargate behind an internal ALB
with a CloudFront front door via `compute: new EcsFargateCompute()`.
`@aws-blocks/compute-common` carries the shared parts (backend image asset,
handler environment mirroring, CloudFront front door construct).
