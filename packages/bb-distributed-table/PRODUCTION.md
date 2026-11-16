# DistributedTable: production settings

Scaling limits, cost, and the durability, deletion-protection and encryption settings of the DynamoDB table behind `DistributedTable`. For the API and examples, see [README.md](./README.md).

## Scaling & Cost (AWS)

- **Billing:** PAY_PER_REQUEST — no provisioned capacity to manage
- **Latency:** Single-digit ms reads and writes
- **Throughput:** Scales automatically, no upper limit on table size
- **Item size limit:** 400 KB per item
- **GSI limit:** Up to 20 global secondary indexes per table
- **Cost:** ~$1.25 per million writes, ~$0.25 per million reads
- **Durability:** 99.999999999% (11 nines) across 3 AZs

## Durability & Security defaults

Durability posture comes from the **stack-wide `BlocksDefaults`** you pass to `BlocksStack.create` / `BlocksBackend.create` (`BlocksPresets.production` or `BlocksPresets.sandbox` from `@aws-blocks/core/cdk`) — the same knobs every Building Block reads, so a table's removal policy, deletion protection, and continuous-backup posture all follow the app's chosen preset. There's no per-block `sandboxMode` guessing.

Under **`BlocksPresets.production`**, every table this block provisions ships with:

- **Point-in-Time Recovery** enabled (`defaults.pointInTimeRecovery`) — restore to any second in the last 35 days.
- **Retained + deletion-protected** (`defaults.removalPolicy = RETAIN`, `defaults.deletionProtection = true`) — neither a stack teardown nor a stray `cdk destroy`/console delete can wipe the table until you explicitly relax it. (Equivalent to `protection: 'locked'`.)
- **SSE-KMS** with the AWS-managed `aws/dynamodb` key — encryption-at-rest that's auditable via CloudTrail, at no per-key charge.

Under **`BlocksPresets.sandbox`** these flip the other way — PITR off, `RemovalPolicy.DESTROY`, deletion protection off (equivalent to `protection: 'disposable'`) — so throwaway stacks stay cheap and `sandbox:destroy` is a one-command teardown. SSE-KMS stays on in both (encryption isn't part of `BlocksDefaults` — it's a per-block option defaulting to `aws-managed`).

> **PITR is not free.** Point-in-Time Recovery charges for continuous-backup storage (per GB-month of table size), so a large production table carries an ongoing cost. It's on by default because unrecoverable data loss is usually the worse outcome — but for regenerable data (caches, derived tables) set `pointInTimeRecovery: false`.

> **`protection: 'locked'`/`'retained'` orphans the table on stack delete.** Because the removal policy is `RETAIN`, deleting the stack leaves the table behind (by design — your data survives). But the table name is derived deterministically from the block's id, so **redeploying the same app afterward fails with `Table already exists`** until you delete the orphaned table (`aws dynamodb delete-table`, after disabling deletion protection if `'locked'`) or import it into the new stack. This is inherent to retain-on-delete; use `protection: 'disposable'` for tables you expect to recreate freely.

> **Indexes follow the config while the table is in the stack.** Removing an index (or the whole `indexes` option) from your config and redeploying drops it from the table. When the table itself leaves the stack (you delete the stack, or remove the `DistributedTable` from your app) its indexes are left alone: an orphaned `'locked'`/`'retained'` table keeps all of them, so importing it into a new stack needs no index rebuild. To tell the two apart the GSI manager reads the stack's template. If it cannot read it in the cleanup phase of an update (or of a rolled-back update), it leaves the indexes in place and reports a `DELETE_FAILED` event for the table's GSI custom resource (logical ID containing `gsiresource`) that names the table and the indexes. The deploy itself still succeeds, so check the deploy output (or the stack's events) for that event. To remove an index your config no longer has, run `aws dynamodb update-table --table-name <table> --global-secondary-index-updates '[{"Delete":{"IndexName":"<index>"}}]'`; DynamoDB takes one index change per call, so wait for each delete to finish before the next.

Every stack default is overridable per table (a per-block option always wins over `defaults`):

```typescript
// Cost-sensitive prod table: keep it protected, skip PITR's backup cost
const cache = new DistributedTable(scope, 'cache', {
  schema, key: { partitionKey: 'id' },
  pointInTimeRecovery: false,
});

// Long-lived data you still want to be able to delete directly
const staging = new DistributedTable(scope, 'staging', {
  schema, key: { partitionKey: 'id' },
  protection: 'retained',   // survives stack delete, but not deletion-protected
});

// Compliance-strict table: dedicated customer-managed KMS key
const ledger = new DistributedTable(scope, 'ledger', {
  schema, key: { partitionKey: 'id' },
  encryption: 'customer-managed',
});

// Share one customer-managed key across several tables (one key, one bill)
const key = DistributedTable.fromKmsKey('arn:aws:kms:us-east-1:111122223333:key/abcd-1234');
const orders = new DistributedTable(scope, 'orders', {
  schema, key: { partitionKey: 'id' },
  encryption: key,
});
const events = new DistributedTable(scope, 'events', {
  schema, key: { partitionKey: 'id' },
  encryption: key,
});
```

> Overrides always win over the environment default, so you can force a fully durable, protected table in a sandbox (or relax one in prod) explicitly. When you bring your own table via `fromExisting()`, none of these options apply — you own that table's configuration.

> **`customer-managed` provisions a dedicated CMK per table** — an app with a dozen customer-managed tables gets a dozen KMS keys (~$1/month each, plus request charges). To share one key across several tables, create the key once and pass `DistributedTable.fromKmsKey(keyArn)` as the `encryption` option on each table (as in the last example above). Use the default `'aws-managed'` unless a table needs its own rotation/key-policy control.
