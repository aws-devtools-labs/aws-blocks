<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->

# KnowledgeBase — Design Decisions

Short rationale notes for non-obvious infrastructure choices in
`src/index.cdk.ts`. These exist to save the next maintainer a round of
archaeology.

## D1 — Raw `s3.Bucket` for the data bucket (not the `FileBucket` Building Block)

The data bucket is provisioned with a raw `aws-cdk-lib/aws-s3` `s3.Bucket`
rather than the `FileBucket` Building Block, even though `FileBucket` exists for
"an app needs an S3 bucket" use cases.

Bedrock ingestion assumes an IAM role that must **read** the data bucket, and
the Knowledge Base / Data Source wiring needs low-level bucket primitives that
`FileBucket` intentionally does not expose:

- **`bucketArn`** — fed verbatim into `CfnDataSource.s3Configuration.bucketArn`.
- **`grantRead(role)`** — grants the Bedrock service-principal role read access
  with the exact resource scoping CDK generates.
- **`enforceSSL: true`** — required posture for the bucket policy.
- **`PhysicalName.GENERATE_IF_NEEDED`** — a CDK-generated name so the bucket can
  be referenced cross-construct (and, for an imported `s3://` source, swapped
  for `Bucket.fromBucketName`) without the caller having to name it.

`FileBucket` is a higher-level, app-facing abstraction (presigned uploads,
client access patterns) and does not surface these primitives. Reaching for the
raw L2 here keeps the Bedrock IAM grant precise and avoids bending `FileBucket`
into an infrastructure role it was not designed for.

## D2 — S3 Vectors resources mirror the data bucket's removal policy

The vector store is a pair of S3 Vectors **L1** resources
(`s3vectors.CfnVectorBucket` + `s3vectors.CfnIndex`). Unlike the L2 `s3.Bucket`
— which defaults to `RETAIN` and supports `autoDeleteObjects` — these L1
resources rely solely on their CloudFormation `DeletionPolicy`, whose default is
`Delete`. Left unmanaged they are inconsistent with the data bucket on teardown.

We therefore apply a removal policy to both, computed from the **same** `destroy`
signal that drives the data bucket:

- `removalPolicy: 'destroy'` (or sandbox mode with no explicit policy) →
  `RemovalPolicy.DESTROY` → `DeletionPolicy: Delete`. The vector bucket + index
  are dropped alongside the (auto-emptied) data bucket.
- otherwise → `RemovalPolicy.RETAIN` → `DeletionPolicy: Retain`, matching the
  data bucket's `RETAIN`-by-default posture so customer data is never silently
  destroyed.

`applyRemovalPolicy()` sets both `DeletionPolicy` and `UpdateReplacePolicy`.
There is no `autoDeleteObjects` equivalent for S3 Vectors, but a vector bucket
deleted by CloudFormation is removed with its contents, so no manual emptying
step is needed for the vector store.

## D3 — Teardown caveat: the stack-level `RemovalPolicies` aspect cannot auto-empty the data bucket

Some templates force a whole stack to be destroyable with a CDK aspect:

```ts
import { RemovalPolicies } from 'aws-cdk-lib';
RemovalPolicies.of(stack).destroy();
```

This aspect flips every resource's `DeletionPolicy` to `Delete`, **but it cannot
enable `autoDeleteObjects`** on a bucket — `autoDeleteObjects` is a constructor
behavior (it provisions a custom resource + Lambda that empties the bucket on
delete), not a CloudFormation attribute an aspect can toggle after the fact.

Consequence: if you rely solely on the stack-level aspect and do **not** pass
`removalPolicy: 'destroy'` to the KnowledgeBase, the data bucket's
`DeletionPolicy` becomes `Delete` but it still has objects in it, so
CloudFormation's `DELETE` fails with `BucketNotEmpty` and the teardown stalls.

**Recommendation:** for a clean teardown, pass `removalPolicy: 'destroy'` to the
KnowledgeBase (or run in sandbox mode). That path pairs `RemovalPolicy.DESTROY`
with `autoDeleteObjects` on the data bucket and `DeletionPolicy: Delete` on the
S3 Vectors resources (see D2), so the bucket is emptied and every resource is
removed without manual intervention.
