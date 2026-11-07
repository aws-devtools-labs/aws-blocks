# FileBucket: production settings

Access logging, KMS encryption, Object Lock, scaling limits and cost of the S3 bucket behind `FileBucket`. For the API and examples, see [README.md](./README.md).

## Access Logging

Opt in to S3 server access logging. A dedicated, locked-down log bucket is provisioned and access logs expire automatically after the stack posture's `logRetention` (`ONE_WEEK` in sandbox, `ONE_YEAR` in production):

```typescript
// Logs delivered to a separate locked-down bucket.
// Retention follows the stack posture's logRetention default — not a per-block option.
const bucket = new FileBucket(scope, 'uploads', {
  accessLogging: true,
});
```

To turn S3 access logging on for every FileBucket without enabling API Gateway access logging, set `storageAccessLogging` on the stack defaults:

```typescript
await BlocksStack.create(app, stackName, {
  // ...
  defaults: { ...BlocksPresets.production, storageAccessLogging: true },
});
```

## Encryption with KMS

Objects are encrypted with S3-managed keys (SSE-S3) by default. To control the key yourself, use a customer-managed KMS key:

```typescript
// A dedicated key for this bucket (yearly rotation, removed with the bucket).
const invoices = new FileBucket(scope, 'invoices', { encryption: 'customer-managed' });

// Or share a key you already own across buckets and tables.
const key = FileBucket.fromKmsKey('arn:aws:kms:us-east-1:111122223333:key/abcd-1234');
const exports = new FileBucket(scope, 'exports', { encryption: key });
```

The runtime role is granted `kms:Decrypt` / `kms:GenerateDataKey*` on the key, so `put`/`get` and presigned URLs keep working. For a key you bring yourself, its key policy must delegate to IAM in the account (the default key policy does). KMS adds a monthly key charge; S3 Bucket Keys keep per-request KMS charges low.

## Object Lock

Protect files from being overwritten or permanently deleted for a fixed period (write-once-read-many):

```typescript
const auditLog = new FileBucket(scope, 'audit-log', {
  objectLock: { mode: 'governance', retentionDays: 365 },
});
```

Every new version is locked for `retentionDays`. `delete(path)` still hides the file (S3 adds a delete marker), but permanently deleting a locked version with `delete(path, { versionId })` fails until the lock expires. In `'compliance'` mode nobody, including the account root user, can remove a locked version early; `'governance'` mode allows principals with `s3:BypassGovernanceRetention` to do so.

**Upload through the backend.** S3 requires a signed `Content-MD5` or checksum header on every upload to an Object Lock bucket. A presigned URL is created before the file is known, so it can't carry one, and S3 rejects the upload. On these buckets `putUrl()` and `createUploadHandle()` throw `FileBucketErrors.PresignedUploadUnsupported` (locally and on AWS) rather than return a URL that fails. `put()` works, because the SDK adds the checksum. Downloads (`getUrl()`, `getFileHandle()`) are unaffected.

Object Lock can be added to a bucket that is already deployed, but S3 can't turn it off once it's on. Locked objects also block teardown, so the bucket must be retained — pass `removalPolicy: 'retain'` when using Object Lock in a sandbox.

## Scaling & Cost (AWS)

- **Billing:** Per-request plus storage — no provisioned throughput
- **Latency:** First-byte latency typically 100–200 ms
- **Throughput:** Scales automatically, 5,500 GET and 3,500 PUT requests/second per prefix
- **Object size limit:** 5 TB per object
- **Cost:** ~$0.005 per 1,000 PUT requests, ~$0.0004 per 1,000 GET requests, ~$0.023/GB/month storage
- **Durability:** 99.999999999% (11 nines) across 3+ AZs
