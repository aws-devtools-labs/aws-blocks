---
"@aws-blocks/bb-distributed-data": minor
"@aws-blocks/data-common": minor
"@aws-blocks/bb-data": patch
"@aws-blocks/blocks": minor
"@aws-blocks/core": minor
---

feat(bb-distributed-data): live, local-first reads with `DistributedDatabase({ sync })` and `db.shape()`

A `DistributedDatabase` (Aurora DSQL) can now stream rows to the browser. The API is
the same as `Database` sync: add `sync: { tables: [...] }` to the options and
return `db.shape({ table, where })` from an API method. The client receives the same
`Shape<T>`, so an app can move between `Database` and `DistributedDatabase` without
frontend changes.

```ts
const db = new DistributedDatabase(scope, 'main', {
  migrationsPath: './aws-blocks/dsql-migrations',
  sync: { tables: ['todos'] },
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async todos() {
    const user = await auth.requireAuth(context);
    return db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${user.userId}` });
  },
}));
```

- A shape keeps no state on the server. To load, the client sends a digest of the
  rows it holds, and the server returns only the groups of rows that differ.
- Aurora DSQL change data capture (CDC) sends changes to a Kinesis data stream. The
  app Lambda reads it and tells open shapes on the changed table which keys changed,
  over a WebSocket channel. The keys are encrypted, and the server reads only those
  rows.
- Your own writes are in the shape when the API call returns. The database sends the
  written keys (encrypted) with the response, and the client reads just those rows
  into open shapes before the call resolves. Aurora DSQL reads are strongly
  consistent, so there is no wait for CDC.
- Reads stay local and under a microsecond while other clients write, with tens of
  thousands of rows: a change costs O(changed rows) in the browser.
- A write wakes only the shapes it can affect when their filter has a
  `column = value` term.

Shapes also support (both `Database` and `DistributedDatabase`, locally and on AWS):

- **Filters that read other tables:** `where` may use subqueries
  (`board_id IN (SELECT board_id FROM members WHERE user_id = ...)`); rows move in and
  out when the other table changes. Every table the filter reads must be in
  `sync.tables`.
- **Progressive loading:** `mode: 'changes_only'` shapes start empty; load rows with
  `shape.requestSnapshot({ where, orderBy, limit, offset })` for pagination and
  search. Queries are structured (never SQL), limited to `queryableColumns`, and
  always combined with the shape's own filter.
- **camelCase rows:** `columnMapping: 'snakeCamel'`.
- **Schema changes:** after a migration, open shapes reload in the new form.
- **React:** `useShape(() => api.todos(), deps)` from `@aws-blocks/blocks/react`.

- When no client is connected, sync costs only the Kinesis stream (one provisioned
  shard, about $11 per month in us-west-2). Set `sync.shards` for higher write rates.

`@aws-blocks/data-common`: the shape types, shape tokens, the client shape base
class, and the shape client middleware move here, so that both SQL blocks share one
implementation. New exports `./sync`, `./sync-shared`, `./sync-client`, and
`./react`.

`@aws-blocks/bb-data`: uses the shared implementation from `@aws-blocks/data-common`.
No change to its API. A change to a `Database` shape no longer rebuilds `shape.rows`
from scratch, so large shapes stay fast under frequent changes. `ShapeDescriptor` has two new optional fields
(`protocol`, `bell`) that `Database` shapes do not set.

`@aws-blocks/blocks`: exports the `DistributedSyncOptions` type, and a new
`@aws-blocks/blocks/react` entry with `useShape` (`react` is an optional peer).

`@aws-blocks/core`: response hints, so a Building Block can send its client
middleware facts about an API call (additive). Server: `addResponseHint(name, value)`
in `@aws-blocks/core/bb-utils`, sent in an `x-blocks-hints` response header.
Client: middleware `onSettled(data, request, hints)`, awaited before the call
resolves.
