# KnowledgeBase — Design

Design document for KnowledgeBase. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-knowledge-base`
**Type:** Primitive (new infrastructure)
**AWS Services:** Amazon Bedrock Knowledge Bases, S3, S3 Vectors

## API Surface

```typescript
class KnowledgeBase extends Scope {
	constructor(scope: ScopeParent, id: string, options: KnowledgeBaseOptions);
	retrieve(query: string, options?: RetrieveOptions): Promise<RetrieveResult[]>;
}

interface KnowledgeBaseOptions {
	/** Document source — local folder path or `s3://` URI pointing to a bucket or folder. */
	source: string;
	/** How documents are split into chunks. Default: `{ strategy: 'semantic' }`. */
	chunking?: ChunkingConfig;
	/** Embedding dimensions (256, 512, or 1024). Default: 1024. */
	embeddingDimensions?: 256 | 512 | 1024;
	/** Human-readable description for the knowledge base. */
	description?: string;
	/** CDK removal behavior for BB-created data buckets. Default: RETAIN (preserved on `cdk destroy`) unless sandbox mode. Pass `'destroy'` for ephemeral stacks. */
	removalPolicy?: 'destroy' | 'retain';
	/** Optional logger for internal BB diagnostics. Defaults to error-level logging. */
	logger?: ChildLogger;
}

type ChunkingStrategy = 'semantic' | 'fixed' | 'hierarchical' | 'none';

interface ChunkingConfig {
	strategy?: ChunkingStrategy;
	chunkSize?: number;
	chunkOverlap?: number;
	breakpointPercentile?: number;
}

interface RetrieveOptions {
	/** Maximum results (1–100). Default: 10. */
	maxResults?: number;
	/** Metadata filter with AND semantics. */
	filter?: MetadataFilter;
}

type MetadataFilter = Record<string, { equals: string }>;

interface RetrieveResult {
	text: string;
	score: number;
	source: string;
	metadata: Record<string, string>;
}
```

## Error Constants

```typescript
export const KnowledgeBaseErrors = {
	RetrievalFailed: 'RetrievalFailedException',
	NotReady: 'KnowledgeBaseNotReadyException',
	InvalidSource: 'InvalidSourceConfigException',
	InvalidFilter: 'InvalidFilterException',
	ValidationError: 'KnowledgeBaseValidationError',
	BrowserNotSupported: 'BrowserNotSupportedException',
} as const;
```

## Design Decisions

### D-KB-1: S3 Vectors over OpenSearch / Aurora pgvector

**Decision:** Use S3 Vectors (`AWS::S3Vectors::VectorBucket` + `CfnIndex`) as the vector store instead of OpenSearch Serverless or Aurora pgvector.

**Rationale:** S3 Vectors is fully serverless with no minimum cost, no cluster management, and pay-per-query pricing. OpenSearch Serverless has a ~$700/month baseline (2 OCUs minimum). Aurora pgvector requires a provisioned database. For a Building Block that should "just work" from zero scale, S3 Vectors is the only option that matches the Blocks philosophy of no idle cost.

### D-KB-2: Fire-and-forget ingestion via AwsCustomResource

**Decision:** Trigger `StartIngestionJob` via `AwsCustomResource` on Create/Update. Ingestion runs asynchronously — no deploy-time wait.

**Rationale:** Ingestion can take minutes to hours depending on corpus size. Blocking `cdk deploy` until ingestion completes would make iterative development painful. Fire-and-forget means the deploy finishes quickly and ingestion happens in the background. The trade-off is that the knowledge base may return stale or empty results for a brief window after deploy. This is acceptable because the alternative (using a CDK `Provider` with `isComplete` polling) adds significant complexity and Lambda cold-start cost for a one-time operation.

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

## Infrastructure (CDK)

Creates the following resources:

1. **S3 Data Bucket** — Stores source documents. Created new for local folder sources; imported via `Bucket.fromBucketName` for `s3://` URI sources. Block public access enabled, SSE-S3 encryption. Removal policy defaults to CDK's default (`RETAIN`) — the bucket and its documents are preserved on `cdk destroy` — unless `removalPolicy: 'destroy'` is set or the stack is in sandbox mode (`sandboxMode` context), in which case it becomes `DESTROY` with `autoDeleteObjects` enabled.

2. **S3 Vectors VectorBucket + Index** — Serverless vector store for embeddings. Index configured with `float32` data type, cosine distance metric, and configurable dimensions (default 1024). `AMAZON_BEDROCK_TEXT` and `AMAZON_BEDROCK_METADATA` marked as non-filterable metadata keys.

3. **IAM Role** — Assumed by `bedrock.amazonaws.com` (scoped via `aws:SourceAccount`). Grants: S3 read on data bucket, S3 Vectors CRUD on vector bucket/index, `bedrock:InvokeModel` on Titan V2 (both inference profile and foundation model ARNs).

4. **CfnKnowledgeBase** — Bedrock Knowledge Base with `VECTOR` type, Titan V2 embedding model, S3 Vectors storage configuration (referencing the index ARN).

5. **CfnDataSource** — Connects the S3 data bucket to the knowledge base. Includes chunking configuration mapped from `ChunkingConfig` options. Supports `inclusionPrefixes` for S3 URI sources with a path component.

6. **BucketDeployment** — Syncs local folder contents to S3 (folder source only). Includes auto-generated `.metadata.json` sidecar files layered as a second source asset.

7. **AwsCustomResource (StartIngestionJob)** — Fires `bedrock:StartIngestionJob` on Create/Update. Ingestion runs asynchronously. Depends on both the data source and bucket deployment (when present) so documents are in S3 before ingestion starts.

**Environment variables injected:** `BLOCKS_{FULLID}_KB_ID`
**IAM grants to handler:** `bedrock:Retrieve` on the knowledge base ARN

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
