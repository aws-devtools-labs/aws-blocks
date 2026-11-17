---
"@aws-blocks/bb-distributed-data": patch
---

In local dev, a `DistributedDatabase` transaction now has the local database to itself until it commits or rolls back. Before, a statement or transaction started elsewhere while one was open ran inside it: a standalone write was rolled back when that transaction failed, and two overlapping read-modify-write transactions both committed and lost an update. Overlapping work now runs one piece at a time.

Statements on the block inside its own `transaction()` callback still run in that transaction, and a nested `transaction()` on the same block is refused locally with `TransactionFailedException` instead of waiting forever.
