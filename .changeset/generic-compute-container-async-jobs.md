---
"@aws-blocks/bb-compute": minor
"@aws-blocks/bb-container-compute": minor
"@aws-blocks/bb-async-job": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

feat(compute): generic `Compute` block with container-backed long-running jobs

Adds a capability-driven compute surface and lets an `AsyncJob` run on a
container (AWS Fargate) instead of Lambda — for work beyond Lambda's envelope
(a wall-clock budget over 15 minutes, a long-lived process, or more memory than
Lambda offers). All net-new surface; nothing existing changes shape.

**`Compute` (new, `@aws-blocks/bb-compute`).** The one compute block customers
use. Describe a workload's capabilities — `timeoutSeconds`, `memory`, `cpu`,
`longLived`, `image` — and Blocks selects the backing AWS service: a modest
request/response workload stays on Lambda; anything that exceeds Lambda's
envelope runs on a container. The service name never appears in the API — Blocks
knows which service satisfies the stated needs. The concrete backing computes
(`LambdaCompute`, and the new internal `ContainerCompute`) stay internal.

**`AsyncJob({ compute })`.** A job's handler can be placed on a `Compute`. On a
Lambda compute delivery is unchanged (a native SQS event source). On a container
compute the container runtime self-starts an **owner-matched** SQS poller
(exactly one compute drains each queue) and enforces a **per-handler wall-clock
limit** from the compute's `timeoutSeconds`, aborting a handler that overruns so
its message redrives to the DLQ. In local dev, compute assignment is transparent
— handlers run in-process exactly as before.

**Central lazy VPC.** A container is VPC-resident, so it hooks into the
framework's existing lazy VPC: the one shared app VPC is derived on first need
(NAT egress) and a Lambda-only sibling joins the same VPC. No `vpc` prop
required.

**core.** `ComputeCapabilities` + `selectComputeKind`, the `ComputeHandle`
marker, and a container-runtime seam (`runContainer`, `registerContainerPoller`,
worker-mode helpers) that the co-bundled container image entry drives.
