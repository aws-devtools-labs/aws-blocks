---
"@aws-blocks/bb-data": patch
---

Add `@aws-blocks/bb-data/data-api`: browser-direct reads and writes with no hand-written endpoint per query, authorized by Postgres Row Level Security.

One endpoint serves every table:

```ts
// server
import { createDataApi } from '@aws-blocks/bb-data/data-api';

const dataApi = createDataApi({
  db,
  schema: tableMeta,
  tables: ['notes'],                                  // opt-in only
  auth: async () => auth.requireAuth(context),        // required
});

export async function POST(request: Request) {
  return Response.json(await dataApi.execute(await request.json()));
}
```

```ts
// browser — no URL, no API key; rides the session you already have
import { createRemoteDataClient } from '@aws-blocks/bb-data/data-api/client';

const data = createRemoteDataClient<TableMeta>(transport);
const notes = await data.from('notes').select('id', 'text').eq('done', false).limit(20);
```

The security posture:

- **Authentication is mandatory.** `auth` is required and must resolve a user; there is no anonymous mode to forget to disable. Callers are authenticated *before* validation, so an anonymous prober learns nothing about the schema.
- **Tables are opt-in.** A table in the schema but absent from `tables` is rejected.
- **The client never sends SQL.** It sends a query description; the server validates it against the introspected schema and a closed operator set, then builds the statement. Unknown tables, columns, operators, order directions and non-scalar filter values are all refused.
- **Every query runs under `withRLS`** with the caller's claims, so row authorization is Postgres policy rather than application code.
- **Writes are constrained.** `update` and `delete` require a filter, database-managed columns cannot be set, and a limit is always applied so one request cannot pull an entire table.

The browser client mirrors the server-side fluent client's shape, so the same query reads the same in a Server Component and a Client Component, and it is safe to import into browser code: no driver, no connection details.
