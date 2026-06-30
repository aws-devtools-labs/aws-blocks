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
| `KnowledgeBaseErrors.InvalidSource` | `InvalidSourceConfigException` | Source folder not found or invalid config |
| `KnowledgeBaseErrors.InvalidFilter` | `InvalidFilterException` | Invalid filter keys in Bedrock query |
| `KnowledgeBaseErrors.ValidationError` | `KnowledgeBaseValidationError` | Empty or invalid query |
| `KnowledgeBaseErrors.BrowserNotSupported` | `BrowserNotSupportedException` | Used in a browser context — KnowledgeBase is server-side only |

## Deploy Behavior

`cdk deploy` automatically triggers document ingestion (fire-and-forget). Ingestion runs asynchronously after the deploy completes. Check the AWS console to monitor ingestion progress.

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
