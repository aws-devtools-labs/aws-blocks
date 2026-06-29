# KnowledgeBase — Design

Design document for KnowledgeBase. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-knowledge-base`
**Type:** Primitive (new infrastructure)
**AWS Services:** Amazon Bedrock Knowledge Bases, S3, S3 Vectors

## Design Decisions

### D-KB-1: S3 Vectors over OpenSearch / Aurora pgvector

**Decision:** Use S3 Vectors (`AWS::S3Vectors::VectorBucket` + `CfnIndex`) as the vector store instead of OpenSearch Serverless or Aurora pgvector.

**Rationale:** S3 Vectors is fully serverless with no minimum cost, no cluster management, and pay-per-query pricing. OpenSearch Serverless has a ~$700/month baseline (2 OCUs minimum). Aurora pgvector requires a provisioned database. For a Building Block that should "just work" from zero scale, S3 Vectors is the only option that matches the Blocks philosophy of no idle cost.

### D-KB-2: Fire-and-forget ingestion via AwsCustomResource

**Decision:** Trigger `StartIngestionJob` via `AwsCustomResource` on Create/Update. Ingestion runs asynchronously — no deploy-time wait.

**Rationale:** Ingestion can take minutes to hours depending on corpus size. Blocking `cdk deploy` until ingestion completes would make iterative development painful. Fire-and-forget means the deploy finishes quickly and ingestion happens in the background. The trade-off is that the knowledge base may return stale or empty results for a brief window after deploy. This is acceptable because the alternative (using a CDK `Provider` with `isComplete` polling) adds significant complexity and Lambda cold-start cost for a one-time operation.

**Resolution of the warm-up window:** The `isReady()` / `waitUntilReady()` readiness API (see [README.md](./README.md#readiness)) closes the gap left by fire-and-forget ingestion. Rather than blocking the deploy, callers poll the data source's ingestion-job status at runtime (`ListIngestionJobs` / `GetIngestionJob`) and gate `retrieve()` on completion — keeping deploys fast while giving application code a reliable "is the KB queryable yet?" signal. `COMPLETE` → ready, `FAILED` → throws `IngestionFailedException`, anything else (or no jobs yet) → not ready.

**Source coverage (folder and imported `s3://`):** Both a local-folder source and an imported `s3://` URI create a BB-managed `CfnDataSource` and register its `DATA_SOURCE_ID` unconditionally, so the readiness API tracks the ingestion job for either source type — `isReady()` / `waitUntilReady()` reflect that data source's most recent ingestion job in both cases. (For an `s3://` source the construct skips the `BucketDeployment` step, since the documents are expected to already be in the bucket, but it still creates the data source and fires the ingestion job — so readiness is tracked the same way.) The only case with nothing to track is a deployment that predates this readiness API: such a handler has no `DATA_SOURCE_ID` injected, so `isReady()` returns `true` immediately (treating "no managed data source" as ready). Re-deploying injects the id and enables readiness tracking.

### D-KB-3: Semantic chunking as default strategy

**Decision:** Default chunking strategy is `'semantic'` (breakpoint-based topic detection), not fixed-size.

**Rationale:** Semantic chunking produces higher-quality retrieval results by splitting at natural topic boundaries rather than arbitrary token counts. The breakpoint percentile threshold (default 95) can be tuned. Fixed-size chunking is available for customers who need deterministic chunk sizes or have very uniform document structure.

### D-KB-4: Titan Text Embeddings V2 with configurable dimensions

**Decision:** Use `amazon.titan-embed-text-v2:0` as the embedding model with a configurable output dimension (256, 512, or 1024; default 1024).

**Rationale:** Titan V2 is an AWS first-party model — no cross-account model access or marketplace subscription needed. It supports Matryoshka embeddings (variable output dimensions), letting customers trade accuracy for cost/storage. 1024 dimensions is the full-fidelity default; 256 is viable for cost-sensitive workloads with modest accuracy trade-off.

### D-KB-5: retrieve() only — no retrieveAndGenerate

**Decision:** KnowledgeBase exposes only `retrieve()` (vector search), not `retrieveAndGenerate()` (search + LLM answer).

**Rationale:** Blocks already has a separate Agent Building Block that handles RAG orchestration (retrieve + generate). Baking generation into KnowledgeBase would create overlapping responsibilities. `retrieve()` is the primitive — it returns ranked chunks that the Agent or application code can feed into any LLM. This keeps KnowledgeBase single-purpose and composable.

### D-KB-6: Folder metadata via auto-generated sidecar files

**Decision:** During CDK synth, auto-generate `.metadata.json` sidecar files for documents in subfolders. Each sidecar sets a `folder` metadata attribute derived from the top-level subfolder name. Customer-provided sidecars take precedence and are never overwritten.

**Rationale:** Bedrock Knowledge Bases support document-level metadata via sidecar files, but customers shouldn't need to manually create them for the common case of folder-based categorization. Auto-generation means `retrieve({ filter: { folder: { equals: 'faq' } } })` works out of the box when documents are organized in `./knowledge/faq/`. The mock implementation mirrors this behavior by reading sidecar files and falling back to directory-structure-based folder metadata.

### D-KB-7: nonFilterableMetadataKeys for internal Bedrock keys

**Decision:** The S3 Vectors index is configured with `nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA']`.

**Rationale:** Bedrock injects internal metadata keys (`AMAZON_BEDROCK_TEXT` for chunk content, `AMAZON_BEDROCK_METADATA` for source location) into every vector record. These are large string values that should not be indexed for filtering — they would waste storage and slow down filter queries. Marking them non-filterable excludes them from the filter index while keeping them available for retrieval.

### D-KB-8: Browser stub throws immediately

**Decision:** The `index.browser.ts` entry point throws `BrowserNotSupportedException` on construction.

**Rationale:** KnowledgeBase requires Bedrock API access (AWS runtime) or filesystem reads (mock). Neither is available in the browser. Throwing at construction — not at `retrieve()` time — gives developers an immediate, clear error message guiding them to use server actions, API routes, or Lambda handlers. This follows the same pattern as other server-only Building Blocks.

### D-KB-9: Raw `s3.Bucket` for the data bucket (not the `FileBucket` Building Block)

**Decision:** Provision the data bucket with a raw `aws-cdk-lib/aws-s3` `s3.Bucket` rather than the `FileBucket` Building Block, even though `FileBucket` exists for "an app needs an S3 bucket" use cases.

**Rationale:** Bedrock ingestion assumes an IAM role that must **read** the data bucket, and the Knowledge Base / Data Source wiring needs low-level bucket primitives that `FileBucket` intentionally does not expose:

- **`bucketArn`** — fed verbatim into `CfnDataSource.s3Configuration.bucketArn`.
- **`grantRead(role)`** — grants the Bedrock service-principal role read access with the exact resource scoping CDK generates.
- **`enforceSSL: true`** — required posture for the bucket policy.
- **`PhysicalName.GENERATE_IF_NEEDED`** — a CDK-generated name so the bucket can be referenced cross-construct (and, for an imported `s3://` source, swapped for `Bucket.fromBucketName`) without the caller having to name it.

`FileBucket` is a higher-level, app-facing abstraction (presigned uploads, client access patterns) and does not surface these primitives. Reaching for the raw L2 here keeps the Bedrock IAM grant precise and avoids bending `FileBucket` into an infrastructure role it was not designed for.

### D-KB-10: S3 Vectors resources mirror the data bucket's removal policy

**Decision:** Apply a removal policy to the S3 Vectors L1 resources (`s3vectors.CfnVectorBucket` + `s3vectors.CfnIndex`), computed from the **same** `destroy` signal that drives the data bucket.

**Rationale:** Unlike the L2 `s3.Bucket` — which defaults to `RETAIN` and supports `autoDeleteObjects` — these L1 resources rely solely on their CloudFormation `DeletionPolicy`, whose default is `Delete`. Left unmanaged they are inconsistent with the data bucket on teardown. So:

- `removalPolicy: 'destroy'` (or sandbox mode with no explicit policy) → `RemovalPolicy.DESTROY` → `DeletionPolicy: Delete`. The vector bucket + index are dropped alongside the (auto-emptied) data bucket.
- otherwise → `RemovalPolicy.RETAIN` → `DeletionPolicy: Retain`, matching the data bucket's `RETAIN`-by-default posture so customer data is never silently destroyed.

`applyRemovalPolicy()` sets both `DeletionPolicy` and `UpdateReplacePolicy`. There is no `autoDeleteObjects` equivalent for S3 Vectors, but a vector bucket deleted by CloudFormation is removed with its contents, so no manual emptying step is needed for the vector store.

### D-KB-11: Teardown caveat — the stack-level `RemovalPolicies` aspect cannot auto-empty the data bucket

**Decision:** For a clean teardown, pass `removalPolicy: 'destroy'` to the KnowledgeBase (or run in sandbox mode) rather than relying solely on a stack-level `RemovalPolicies.of(stack).destroy()` aspect.

**Rationale:** The stack-level aspect flips every resource's `DeletionPolicy` to `Delete`, **but it cannot enable `autoDeleteObjects`** on a bucket — `autoDeleteObjects` is a constructor behavior (it provisions a custom resource + Lambda that empties the bucket on delete), not a CloudFormation attribute an aspect can toggle after the fact. Consequence: if you rely solely on the stack-level aspect and do **not** pass `removalPolicy: 'destroy'` to the KnowledgeBase, the data bucket's `DeletionPolicy` becomes `Delete` but it still has objects in it, so CloudFormation's `DELETE` fails with `BucketNotEmpty` and the teardown stalls. Passing `removalPolicy: 'destroy'` (or running in sandbox mode) pairs `RemovalPolicy.DESTROY` with `autoDeleteObjects` on the data bucket and `DeletionPolicy: Delete` on the S3 Vectors resources (see D-KB-10), so the bucket is emptied and every resource is removed without manual intervention.

## Infrastructure (CDK)

Creates the following resources:

1. **S3 Data Bucket** — Stores source documents. Created new for local folder sources; imported via `Bucket.fromBucketName` for `s3://` URI sources. Block public access enabled, SSE-S3 encryption. Removal policy defaults to CDK's default (`RETAIN`) — the bucket and its documents are preserved on `cdk destroy` — unless `removalPolicy: 'destroy'` is set or the stack is in sandbox mode (`sandboxMode` context), in which case it becomes `DESTROY` with `autoDeleteObjects` enabled.

2. **S3 Vectors VectorBucket + Index** — Serverless vector store for embeddings. Index configured with `float32` data type, cosine distance metric, and configurable dimensions (default 1024). `AMAZON_BEDROCK_TEXT` and `AMAZON_BEDROCK_METADATA` marked as non-filterable metadata keys. On teardown these two L1 resources now mirror the data bucket's removal policy — `DeletionPolicy: Delete` when `removalPolicy: 'destroy'` (or sandbox mode), `Retain` otherwise — so they are dropped alongside the data bucket instead of being left behind (see D-KB-10).

3. **IAM Role** — Assumed by `bedrock.amazonaws.com` (scoped via `aws:SourceAccount`). Grants: S3 read on data bucket, S3 Vectors CRUD on vector bucket/index, `bedrock:InvokeModel` on Titan V2 (both inference profile and foundation model ARNs).

4. **CfnKnowledgeBase** — Bedrock Knowledge Base with `VECTOR` type, Titan V2 embedding model, S3 Vectors storage configuration (referencing the index ARN).

5. **CfnDataSource** — Connects the S3 data bucket to the knowledge base. Includes chunking configuration mapped from `ChunkingConfig` options. Supports `inclusionPrefixes` for S3 URI sources with a path component.

6. **BucketDeployment** — Syncs local folder contents to S3 (folder source only). Includes auto-generated `.metadata.json` sidecar files layered as a second source asset.

7. **AwsCustomResource (StartIngestionJob)** — Fires `bedrock:StartIngestionJob` on Create/Update. Ingestion runs asynchronously. Depends on both the data source and bucket deployment (when present) so documents are in S3 before ingestion starts.

**Handler config** (registered via `registerConfig`, surfaced to the runtime as env vars): `BLOCKS_{FULLID}_KB_ID`, `BLOCKS_{FULLID}_DATA_SOURCE_ID` (the data source id drives the `isReady()` / `waitUntilReady()` readiness checks)
**IAM grants to handler:** `bedrock:Retrieve`, `bedrock:GetIngestionJob`, `bedrock:ListIngestionJobs` on the knowledge base ARN (the ingestion-job actions back the readiness checks; the data source and its ingestion jobs are sub-resources of the KB ARN)

## Mock Implementation

- Documents read from the local folder specified in `options.source` (must be a relative path within the project).
- Text files chunked by paragraph (split on double newlines, minimum 20 characters per chunk).
- Relevance scoring via TF-IDF (term frequency–inverse document frequency) — not real embeddings. Algorithm: tokenize → normalized TF → smoothed IDF (`log((N+1)/(df+1)) + 1`) → scores normalized to [0, 1].
- Chunks cached to `.bb-data/{fullId}/chunks.json` via `getMockDataDir()` from core. Data persists across dev server restarts. Wipe with `rm -rf .bb-data`.
- Folder metadata derived from directory structure (top-level subfolder name). Customer-provided `.metadata.json` sidecar files take precedence.
- Metadata filtering via in-memory equality check with AND semantics.
- Supported formats: `.md`, `.txt`, `.html`, `.htm`, `.csv`, `.json`.
- S3 URI sources throw `InvalidSourceConfigException` — they require AWS infrastructure not available locally.

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| TF-IDF scoring vs Bedrock embeddings | Relevance ranking differs — keyword-based vs semantic | Scores are relative within each environment. API contract is identical. Recommend sandbox testing for retrieval quality tuning |
| No PDF/DOCX support in mock | Documents in binary formats are skipped locally | Document the gap; these formats work on AWS where Bedrock handles parsing |
| Paragraph chunking vs Bedrock strategies | Chunk boundaries differ between mock and production | No mitigation — chunking configuration only affects the CDK/Bedrock path. Mock uses simple paragraph splitting for all strategies |
| No ingestion pipeline | Documents are indexed synchronously on first `retrieve()` | No mitigation — the mock doesn't need async ingestion. First call may be slower due to indexing |
| No IAM enforcement | Permission errors only surface in AWS | No mitigation — IAM is handled by CDK grants automatically |
| Immediate consistency | New documents appear instantly vs async ingestion in AWS | No mitigation — eventual consistency in AWS is inherent to the Bedrock ingestion pipeline |
