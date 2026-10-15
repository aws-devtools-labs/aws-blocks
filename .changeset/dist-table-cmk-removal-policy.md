---
"@aws-blocks/bb-distributed-table": patch
---

fix(bb-distributed-table): auto-created CMK follows the table's removal policy on teardown

When `encryption: 'customer-managed'` provisions a dedicated KMS key, that key
defaulted to `RemovalPolicy.RETAIN` and survived a `DESTROY` table teardown as
an orphaned, billed, rotating key — contradicting `sandbox:destroy`. The key now
has the same removal policy as the table it encrypts: destroyed with a
`disposable` table, retained otherwise, so it is never less durable than the
table. An imported key (`DistributedTable.fromKmsKey`) is owned by the caller and
left untouched. A `disposable` table with PITR on also makes that table's backups
unrestorable once destroyed — see DESIGN.md D-DT-11.
