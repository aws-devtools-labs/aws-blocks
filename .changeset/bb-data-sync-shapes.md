---
"@aws-blocks/bb-data": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

feat(bb-data): live, local-first reads with `Database({ sync })` and `db.shape()`

A `Database` can now stream rows to the browser. Add `sync: { tables: [...] }` to
the options, and return `db.shape({ table, where })` from an API method. The client
receives a `Shape<T>` that keeps a local copy of the matching rows and applies
inserts, updates, and deletes as they happen. Reads (`shape.rows`, `shape.get(id)`)
are local and synchronous, so they never wait on the network.

```ts
const db = new Database(scope, 'main', {
  migrationsPath: './aws-blocks/migrations',
  sync: { tables: ['todos'] },
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async todos() {
    const user = await auth.requireAuth(context);
    return db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${user.userId}` });
  },
}));

// Frontend
const todos = await api.todos();
await todos.ready;
todos.subscribe((rows) => render(rows));
```

- The API method that returns a shape is the authorization point. It signs the
  table, row filter, and columns into an expiring token; the client cannot change
  them. When the token expires, the client calls the same method again.
- `currentTxid(tx)` returns the id of a write transaction, and
  `shape.waitForTxid(txid)` resolves when that write has synced back.
- On AWS, `sync` enables logical replication on the Aurora cluster and runs the
  [Electric](https://electric.ax) sync service on Fargate. The app Lambda reaches it
  through an IAM-authorized HTTP API. The stack builds the pinned Electric release
  from source in your account (CodeBuild and ECR), so the deploy needs no local
  Docker. Locally, an in-process emulator of the same protocol
  runs on PGlite, so no extra setup is needed.
- `sync` is not supported with `fromExisting()` or with `minCapacity: 0` (Aurora
  does not auto-pause while logical replication is on). If you enable `sync` on a
  cluster that already exists, reboot its writer once after the deploy.

`@aws-blocks/core`: client middleware `onResponse` now also receives the request
that produced the response, and `getApiUrl()` is exported from
`@aws-blocks/core/client`. Both changes are additive.
