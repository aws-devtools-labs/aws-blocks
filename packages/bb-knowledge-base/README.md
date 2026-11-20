# @aws-cdk-blocks/bb-knowledge-base

Semantic document retrieval backed by Amazon Bedrock Knowledge Bases.

**When to use:** Search over your own documents — FAQs, product guides, support articles, internal wikis. Point it at a folder and query with natural language.

**When NOT to use:** Structured key-value lookups (`KVStore`), relational queries (`Database`), or keyword-only full-text search: `KnowledgeBase` ranks by meaning, not by exact terms.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick start

```typescript
import { Scope, ApiNamespace } from '@aws-cdk-blocks/core';
import { KnowledgeBase } from '@aws-cdk-blocks/bb-knowledge-base';

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
| `isSynced()` | `Promise<boolean>` | Whether the KB is synced with your latest data. `true` once the latest ingestion job is `COMPLETE` (or there is no BB-managed data source to track). Reports data *freshness*, not availability — `retrieve()` is always callable and serves the prior snapshot while a re-ingestion is in flight. Throws `IngestionFailed` if the latest job failed. |
| `asAgentTool(options)` | `KnowledgeBaseAgentTool` | A tool definition for an Agent's `tools` callback. The model supplies only the query; the metadata filter is derived from the per-call tool context by your required `filter` callback. Marked `untrustedOutput: true`. See [Use as an Agent tool](#use-as-an-agent-tool). |
| `waitUntilSynced(options?)` | `Promise<void>` | Poll `isSynced()` until the KB is synced with your latest data or the timeout elapses. Throws `Timeout` if it does not sync in time. Accepts an optional `AbortSignal` to cancel the wait. |

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `source` | `string` | (required) | Document source — local folder path or `s3://` URI pointing to a bucket or folder. |
| `chunking` | `ChunkingConfig` | `{ strategy: 'semantic' }` | How documents are split into chunks. |
| `embeddingDimensions` | `256 \| 512 \| 1024` | `1024` | Embedding model dimensions. |
| `description` | `string` | — | Human-readable description for the knowledge base. |
| `removalPolicy` | `'destroy' \| 'retain'` | stack `defaults` | CDK removal behavior for BB-created data buckets (imported `s3://` URI sources are unaffected). When omitted, follows the stack-wide `defaults` (`production` → RETAIN, `sandbox` → DESTROY). Pass `'destroy'` to drop the bucket on teardown for this KB — also enables `autoDeleteObjects`. |
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

- **Supported formats:** .md, .txt, .html, .htm, .csv, .json (plus binary formats parsed on AWS: .pdf, .doc, .docx, .xls, .xlsx)
- **Max document size:** 50 MB per file

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
| `chunkOverlap` | `number` | `20` | `'fixed'` | Overlap between consecutive chunks, as a percentage of `chunkSize`. 1–99 on AWS (Bedrock's `overlapPercentage`); the mock also accepts 0. |
| `breakpointPercentile` | `number` | `95` | `'semantic'` | Breakpoint percentile for topic-boundary detection (0–100). |

```typescript
chunking: { strategy: 'fixed', chunkSize: 500, chunkOverlap: 10 }
```

### Retrieve Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxResults` | `number` | `10` | Maximum results to return. An integer; a value outside 1–100 is clamped to that range. |
| `filter` | `MetadataFilter` | — | Metadata filter with AND semantics across all key-value pairs. |

### Retrieve Result

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string` | Chunk text content. |
| `score` | `number` | Relevance score 0.0–1.0. |
| `source` | `string` | Source document path or URL. |
| `metadata` | `Record<string, string>` | Document metadata. Includes auto-populated `folder` from subfolders. |

### Sync

`cdk deploy` starts Bedrock ingestion and does not wait for it. Until the first ingestion job completes, `retrieve()` returns an empty array, even for queries that match later. Gate on `isSynced()` or `waitUntilSynced()`:

```typescript
// Block until the KB is synced with your latest data (e.g. right after deploy), then query
await kb.waitUntilSynced({ timeoutMs: 600_000 });
const results = await kb.retrieve('getting started');

// Or check without blocking
if (await kb.isSynced()) {
  const results = await kb.retrieve('getting started');
}

// Cancel the wait with an AbortSignal (e.g. an overall request deadline)
await kb.waitUntilSynced({ signal: AbortSignal.timeout(120_000) });
```

`waitUntilSynced(options?)` polls `isSynced()`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeoutMs` | `number` | `300_000` | Maximum wait in milliseconds. Throws `Timeout` when it elapses. |
| `pollIntervalMs` | `number` | `5_000` | Delay between polls in milliseconds, with ±20% random jitter. Minimum 1. |
| `maxConsecutiveTransientErrors` | `number` | `3` | Transient errors tolerated in a row; the next one is thrown. A poll without an error resets the count. Minimum 0. |
| `signal` | `AbortSignal` | — | Cancels the wait: `waitUntilSynced()` rejects with the signal's abort reason (by default a `DOMException` named `'AbortError'`). |

| A poll fails with | `waitUntilSynced()` |
|---|---|
| Throttling, a network failure or another unrecognized SDK error (`RetrievalFailed`) | Retries, up to `maxConsecutiveTransientErrors` times in a row. |
| `ResourceNotFoundException` right after deploy, while the knowledge base or data source is not visible yet (`NotReady`) | Retries, with the same limit. |
| A `FAILED` ingestion job (`IngestionFailed`) | Throws at once. |
| An unset `KB_ID` env var (`NotReady`) | Throws at once. |

On AWS, `isSynced()` reports the latest ingestion job of the data source, for local-folder and `s3://` sources alike. In local development the mock is always synced, also for an `s3://` source, which the mock's `retrieve()` rejects with `InvalidSourceConfigException`: validate `s3://` sources in a sandbox or production deployment.

## Errors

Match an error by name with `isBlocksError(e, KnowledgeBaseErrors.<Name>)`:

```typescript
import { isBlocksError, KnowledgeBaseErrors } from 'aws-cdk-blocks';
```

| Constant | `error.name` | Thrown when |
|---|---|---|
| `KnowledgeBaseErrors.RetrievalFailed` | `RetrievalFailedException` | Bedrock retrieval call failed |
| `KnowledgeBaseErrors.NotReady` | `KnowledgeBaseNotReadyException` | KB not deployed or env vars missing |
| `KnowledgeBaseErrors.IngestionFailed` | `IngestionFailedException` | The most recent ingestion job failed. Thrown by `isSynced()` and `waitUntilSynced()` |
| `KnowledgeBaseErrors.Timeout` | `KnowledgeBaseTimeoutException` | `waitUntilSynced()` exceeded its timeout before ingestion completed |
| `KnowledgeBaseErrors.InvalidSource` | `InvalidSourceConfigException` | Source folder not found or invalid config |
| `KnowledgeBaseErrors.InvalidFilter` | `InvalidFilterException` | Invalid filter keys in Bedrock query |
| `KnowledgeBaseErrors.ValidationError` | `KnowledgeBaseValidationError` | Empty or invalid query, or a non-integer `maxResults` |
| `KnowledgeBaseErrors.BrowserNotSupported` | `BrowserNotSupportedException` | Used in a browser context — KnowledgeBase is server-side only |

An `IngestionFailed` error keeps Bedrock's failure reasons on the server:

- Its message is the same for every failure and is safe to return to clients.
- Bedrock's `failureReasons` are raw text that can name buckets, object keys or ARNs. They are in the server log and on the non-enumerable `err.cause` (type `IngestionFailureCause`).
- `cause` is absent when Bedrock reported no reasons, so read `err.cause?.failureReasons ?? []`.

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

## Use as an Agent tool

`asAgentTool()` returns a tool definition you pass to the `tool()` factory of an `Agent` (`@aws-cdk-blocks/bb-agent`). Fill the tool context from the authenticated session when you call `agent.stream()`:

```typescript
import { Scope, ApiNamespace } from '@aws-cdk-blocks/core';
import { Auth } from '@aws-cdk-blocks/bb-auth';
import { Agent } from '@aws-cdk-blocks/bb-agent';
import { KnowledgeBase } from '@aws-cdk-blocks/bb-knowledge-base';
import { z } from 'zod';

const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth');
const kb = new KnowledgeBase(scope, 'docs', { source: './knowledge' });

const agent = new Agent(scope, 'assistant', {
  systemPrompt: 'Answer questions from the documentation.',
  toolContextSchema: z.object({ ownerId: z.string() }),
  tools: (tool) => ({
    // `context` is typed from toolContextSchema.
    searchDocs: tool(kb.asAgentTool({
      filter: (context) => ({ owner: { equals: context.ownerId } }),
    })),
  }),
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async ask(message: string) {
    const user = await auth.requireAuth(context);
    // The tool context, and so the search scope, comes from the session: each document carries
    // an `owner` metadata value, and a user searches only their own. For per-tenant scoping, put a
    // tenant id your app looks up for the user in the context instead (`Auth`'s user carries
    // no tenant).
    const result = await agent.stream(message, { userId: user.userSub, context: { ownerId: user.userSub } });
    return { channelId: result.channelId };
  },
}));
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `filter` | `(context) => MetadataFilter \| undefined` (may be async) | (required) | Derives the metadata filter for every search from the tool context. |
| `description` | `string` | generic, includes the KB `description` | Tool description shown to the model. |
| `maxResults` | `number` | `5` | Results per search (same rules as `retrieve()`). A non-integer throws from `asAgentTool()`. |

What the `filter` callback returns decides the search:

- A filter narrows the search to the documents that match it.
- `undefined` searches the whole knowledge base. Write `filter: () => undefined` only when every caller may read every document.
- `null`, `{}`, or a key whose `equals` is missing or empty fails the tool call with `ValidationError`.
- Throw to fail the tool call instead of running an unscoped search.

The tool:

- Returns plain JSON hits (`text`, `score`, `source`, `metadata`).
- Doesn't ask for approval, because retrieval is read-only. Set `needsApproval: true` on the agent's tools that have side effects.
- Takes agent-side fields when you spread the definition: `tool({ ...kb.asAgentTool({ filter }), cannedExamples: { query: 'refund policy' } })`.
- Can be defined at module top level: `asAgentTool()` is synth-safe, and the search runs only when the agent calls the tool.

## Trust Boundary

A knowledge base is one index, not one per user or tenant, and `retrieve()` returns whatever matches. Two consequences:

- **A filter is a query scope, not an access control.** If you keep several users' or tenants' documents in one knowledge base, set the filter in your server code from the authenticated caller (for example `filter: { tenant: { equals: tenantId } }` with a tenant id you look up for the authenticated user). Never take it from the request body or from an agent tool's input, or a caller can read other tenants' documents by changing it.
- **Indexed text is untrusted.** If a source can receive content you don't write yourself, for example an `s3://` source that is a `FileBucket` your users upload to, that content reaches anyone who retrieves it. When results go to an agent, they can carry instructions that try to make it misuse its tools (indirect prompt injection). Use [`asAgentTool()`](#use-as-an-agent-tool), or mark the agent tool that calls `retrieve()` with `untrustedOutput: true`, and see [Retrieved content is untrusted](../bb-agent/README.md#retrieved-content-is-untrusted) in the Agent docs.

## Scaling and cost (AWS)

- **Embedding model:** Amazon Titan Text Embeddings V2
- **Vector store:** S3 Vectors (serverless, no provisioning)
- **Embedding cost:** ~$0.00002 per 1,000 tokens (ingestion)
- **Retrieval cost:** ~$0.00002 per 1,000 tokens (query embedding) + S3 Vectors query cost
- **Storage:** S3 standard pricing for source documents + S3 Vectors for embeddings

## Local development

In local dev mode, KnowledgeBase reads documents from the source folder, splits them into chunks according to the configured `chunking` strategy, and uses TF-IDF for relevance scoring. Results are cached to `.cdk-blocks/local/data/{fullId}/chunks.json` for fast restarts; the cache is keyed on the source folder's contents and the chunking configuration, and is rebuilt automatically when documents are added, edited, or removed, or the chunking settings change.

**Parity notes:**
- Scoring uses TF-IDF (keyword-based) rather than real embeddings. Scores are relative within the mock and won't match production Bedrock scores exactly.
- The TF-IDF tokenizer is Unicode-aware: accents are normalized (so `resume` matches `résumé`) and CJK text is matched via character bigrams.
- Chunking is approximated locally: `'fixed'` uses word-count windows of `chunkSize` words that overlap by `chunkSize × chunkOverlap / 100` words, `'none'` keeps each document whole, and `'semantic'` (and `'hierarchical'`) split on paragraph boundaries.
- `maxResults` and metadata filtering (`equals`, AND) behave as on AWS, except for an unknown filter key: Bedrock can reject it with `InvalidFilterException`; the mock matches nothing and returns `[]`.
- `source` must be a relative path inside the project directory — absolute paths and paths that escape the project (via `..`) are rejected with `InvalidSourceConfigException`.

Wipe cached data with `rm -rf .cdk-blocks/local/data .bb-data`.


## See also

- [Amazon Bedrock Knowledge Bases docs](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html)
