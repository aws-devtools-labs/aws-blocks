# @aws-blocks/bb-knowledge-base

Semantic document retrieval backed by Amazon Bedrock Knowledge Bases.

**When to use:** Search over your own documents — FAQs, product guides, support articles, internal wikis. Point it at a folder and query with natural language.

**When NOT to use:** If you need structured key-value lookups, use `KVStore`. If you need relational queries, use `Database`. If you need full-text keyword search only (no semantic understanding), roll your own with `DistributedTable`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick Start

```typescript
import { Scope, ApiNamespace } from '@aws-blocks/core';
import { KnowledgeBase } from '@aws-blocks/bb-knowledge-base';

const scope = new Scope('my-app');

const kb = new KnowledgeBase(scope, 'docs', {
  source: './knowledge',
  description: 'Product documentation',
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async search(query: string) {
    const results = await kb.retrieve(query, { maxResults: 5 });
    return { results };
  },
}));
```

## API

```typescript
const kb = new KnowledgeBase(scope, id, options)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `retrieve(query, options?)` | `Promise<RetrieveResult[]>` | Search for relevant document chunks. Returns results ranked by relevance score. |
| `isReady()` | `Promise<boolean>` | Whether async ingestion has finished and the KB can serve `retrieve()`. `true` once the latest ingestion job is `COMPLETE` (or there is no BB-managed data source to track). Throws `IngestionFailed` if the latest job failed. |
| `waitUntilReady(options?)` | `Promise<void>` | Poll `isReady()` until the KB is ready or the timeout elapses. Throws `Timeout` if it does not become ready in time. Accepts an optional `AbortSignal` to cancel the wait. |

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `source` | `string` | (required) | Document source — local folder path or `s3://` URI pointing to a bucket or folder. |
| `chunking` | `ChunkingConfig` | `{ strategy: 'semantic' }` | How documents are split into chunks. |
| `embeddingDimensions` | `256 \| 512 \| 1024` | `1024` | Embedding model dimensions. |
| `description` | `string` | — | Human-readable description for the knowledge base. |
| `removalPolicy` | `'destroy' \| 'retain'` | `'retain'` | CDK removal behavior for BB-created data buckets (imported `s3://` URI sources are unaffected). Defaults to RETAIN (bucket and documents preserved on `cdk destroy`) unless sandbox mode. Pass `'destroy'` for ephemeral stacks — also enables `autoDeleteObjects`. |
| `logger` | `ChildLogger` | — | Optional logger for internal operations. When omitted, a default Logger at error level is created. |

### Source Configuration

```typescript
// Local folder — synced to S3 on deploy
new KnowledgeBase(scope, 'docs', { source: './knowledge' });

// Existing S3 bucket (with optional prefix)
new KnowledgeBase(scope, 'docs', { source: 's3://my-bucket' });
new KnowledgeBase(scope, 'docs', { source: 's3://my-bucket/docs/prefix/' });
```

**S3 URI source:** When using an `s3://` URI, the CDK construct imports the existing bucket instead of creating a new one. An optional path prefix narrows which objects Bedrock ingests. No `BucketDeployment` is created — your documents must already be in the bucket. In local development, S3 URI sources are not supported (use a local folder path instead).

### Chunking Strategies

| Strategy | Description |
|----------|-------------|
| `'semantic'` | (Default) Splits at natural topic boundaries using breakpoint detection. |
| `'fixed'` | Fixed-size chunks with configurable `chunkSize` and `chunkOverlap`. |
| `'hierarchical'` | Two-level chunking (parent 1500 tokens, child 300 tokens). |
| `'none'` | No chunking — each document is a single chunk. |

### Chunking Options

`chunking` accepts a `ChunkingConfig`. Options apply only to the relevant strategy; others are ignored.

| Option | Type | Default | Applies to | Description |
|--------|------|---------|------------|-------------|
| `strategy` | `'semantic' \| 'fixed' \| 'hierarchical' \| 'none'` | `'semantic'` | all | Chunking strategy. |
| `chunkSize` | `number` | `300` | `'fixed'` | Max tokens per chunk. |
| `chunkOverlap` | `number` | `20` | `'fixed'` | Overlap percentage between consecutive chunks (0–100). |
| `breakpointPercentile` | `number` | `95` | `'semantic'` | Breakpoint percentile for topic-boundary detection (0–100). |

```typescript
chunking: { strategy: 'fixed', chunkSize: 500, chunkOverlap: 10 }
```

### Retrieve Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxResults` | `number` | `10` | Maximum results to return. Range: 1–100. |
| `filter` | `MetadataFilter` | — | Metadata filter with AND semantics across all key-value pairs. |

### Retrieve Result

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string` | Chunk text content. |
| `score` | `number` | Relevance score 0.0–1.0. |
| `source` | `string` | Source document path or URL. |
| `metadata` | `Record<string, string>` | Document metadata. Includes auto-populated `folder` from subfolders. |

### Readiness

Bedrock ingestion runs asynchronously after deploy, so immediately after `cdk deploy` the knowledge base may not yet be queryable — `retrieve()` returns an empty array even for queries that will later match. Use `isReady()` / `waitUntilReady()` to gate on ingestion completion:

```typescript
// Block until the KB is queryable (e.g. right after deploy), then query
await kb.waitUntilReady({ timeoutMs: 600_000 });
const results = await kb.retrieve('getting started');

// Or check without blocking
if (await kb.isReady()) {
  const results = await kb.retrieve('getting started');
}

// Cancel the wait with an AbortSignal (e.g. an overall request deadline)
await kb.waitUntilReady({ signal: AbortSignal.timeout(120_000) });
```

`waitUntilReady(options?)` accepts `timeoutMs` (default `300_000`), `pollIntervalMs` (default `5_000`, clamped to a 1ms minimum), `maxConsecutiveTransientErrors` (default `3`, minimum `0`), and an optional `signal` (`AbortSignal`). The poll interval carries a small amount of random jitter (±20%) so that many knowledge bases polling after a shared deploy don't fall into lockstep — the jitter only varies the delay *between* polls and never pushes a sleep past `timeoutMs`.

`maxConsecutiveTransientErrors` is the number of *consecutive* transient control-plane errors tolerated before giving up; the counter resets on any clean poll. Two conditions are treated as transient and ridden out: throttling / transient network failures, **and** a *not-yet-visible* knowledge base — in the post-deploy window the control plane can briefly return `ResourceNotFoundException` (the freshly-created KB or data source hasn't propagated yet), which `waitUntilReady()` absorbs rather than giving up on. Terminal errors always short-circuit immediately regardless of the limit: a `FAILED` ingestion job, and a *missing-KB config* error (the `KB_ID` env var is unset — distinct from the transient not-yet-visible case). When `signal` is provided, the wait is cancelled promptly (checked before each poll and during the inter-poll delay), rejecting with the signal's abort reason (by default a `DOMException` named `'AbortError'`).

Both local-folder and imported `s3://` sources register a BB-managed data source, so readiness reflects that data source's ingestion job in either case. (A deployment predating this readiness API has no data source id injected, so `isReady()` returns `true` immediately — there is nothing to track.) In local development the mock is always ready.

## Metadata Filtering

Filter results by document metadata. All conditions use AND semantics:

```typescript
// Only return chunks from the 'faq' folder
const results = await kb.retrieve('how do I reset my password', {
  filter: { folder: { equals: 'faq' } },
});

// Multiple filters (AND)
const results = await kb.retrieve('pricing', {
  filter: {
    folder: { equals: 'products' },
    category: { equals: 'enterprise' },
  },
});
```

Subfolder paths automatically populate the `folder` metadata key. For example, a file at `./knowledge/faq/billing.md` gets `metadata.folder = 'faq'`.

## Error Handling

```typescript
import { isBlocksError } from '@aws-blocks/core';
import { KnowledgeBaseErrors } from '@aws-blocks/bb-knowledge-base';

try {
  const results = await kb.retrieve('query');
} catch (e: unknown) {
  if (isBlocksError(e, KnowledgeBaseErrors.NotReady)) {
    // KB not yet deployed or ingested
  }
  if (isBlocksError(e, KnowledgeBaseErrors.ValidationError)) {
    // Empty query
  }
  throw e;
}
```

| Error Constant | Name | When |
|---|---|---|
| `KnowledgeBaseErrors.RetrievalFailed` | `RetrievalFailedException` | Bedrock retrieval call failed |
| `KnowledgeBaseErrors.NotReady` | `KnowledgeBaseNotReadyException` | KB not deployed or env vars missing |
| `KnowledgeBaseErrors.IngestionFailed` | `IngestionFailedException` | The most recent ingestion job failed (message includes `failureReasons`) — thrown by `isReady()` / `waitUntilReady()` |
| `KnowledgeBaseErrors.Timeout` | `KnowledgeBaseTimeoutException` | `waitUntilReady()` exceeded its timeout before ingestion completed |
| `KnowledgeBaseErrors.InvalidSource` | `InvalidSourceConfigException` | Source folder not found or invalid config |
| `KnowledgeBaseErrors.InvalidFilter` | `InvalidFilterException` | Invalid filter keys in Bedrock query |
| `KnowledgeBaseErrors.ValidationError` | `KnowledgeBaseValidationError` | Empty or invalid query |
| `KnowledgeBaseErrors.BrowserNotSupported` | `BrowserNotSupportedException` | Used in a browser context — KnowledgeBase is server-side only |

## Deploy Behavior

`cdk deploy` automatically triggers document ingestion (fire-and-forget). Ingestion runs asynchronously after the deploy completes. Check the AWS console to monitor ingestion progress, or call [`isReady()` / `waitUntilReady()`](#readiness) from your code to gate queries on ingestion completion.

## Scaling & Cost (AWS)

- **Embedding model:** Amazon Titan Text Embeddings V2
- **Vector store:** S3 Vectors (serverless, no provisioning)
- **Embedding cost:** ~$0.00002 per 1,000 tokens (ingestion)
- **Retrieval cost:** ~$0.00002 per 1,000 tokens (query embedding) + S3 Vectors query cost
- **Storage:** S3 standard pricing for source documents + S3 Vectors for embeddings
- **Max document size:** 50 MB per file
- **Supported formats:** .md, .txt, .html, .htm, .csv, .json (plus binary formats parsed on AWS: .pdf, .doc, .docx, .xls, .xlsx)

## Local Development

In local dev mode, KnowledgeBase reads documents from the source folder, splits them into chunks according to the configured `chunking` strategy, and uses TF-IDF for relevance scoring. Results are cached to `.bb-data/{fullId}/chunks.json` for fast restarts; the cache is keyed on the source folder's contents and the chunking configuration, and is rebuilt automatically when documents are added, edited, or removed, or the chunking settings change.

**Parity notes:**
- Scoring uses TF-IDF (keyword-based) rather than real embeddings. Scores are relative within the mock and won't match production Bedrock scores exactly.
- The TF-IDF tokenizer is Unicode-aware: accents are normalized (so `resume` matches `résumé`) and CJK text is matched via character bigrams.
- Chunking is approximated locally: `'fixed'` uses word-count windows (`chunkSize`/`chunkOverlap`), `'none'` keeps each document whole, and `'semantic'` (and `'hierarchical'`) split on paragraph boundaries.
- `chunkOverlap` is a **percentage** of `chunkSize` in both environments: locally the mock overlaps by `chunkSize × chunkOverlap / 100` words, and the CDK layer maps it to Bedrock's `overlapPercentage` (1–99). The value is directly transferable between local dev and production.
- The API contract (method signatures, error types, result shape) is identical to AWS.
- `maxResults` works identically. Metadata filtering uses the same `equals`/AND semantics, with one asymmetry: in production an unknown or invalid filter key is *typically* rejected server-side by Bedrock (surfaced as `InvalidFilterException` when the service flags the filter), whereas locally the mock silently matches nothing and returns an empty result set.
- `source` must be a relative path inside the project directory — absolute paths and paths that escape the project (via `..`) are rejected with `InvalidSourceConfigException`. S3 URI sources are not supported in local development — use a local folder path.

Wipe cached data with `rm -rf .bb-data`.



## See Also

- [Amazon Bedrock Knowledge Bases docs](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html)
