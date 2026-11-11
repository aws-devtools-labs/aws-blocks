import { ApiNamespace, Scope } from '@aws-blocks/blocks';

// ─── IMPORTANT ───────────────────────────────────────────────────────────────
// Do NOT use local files, in-memory arrays, or local databases for persistence.
// Use Building Blocks for cloud persistence and other common cloud abstractions.
// They work locally with automatic mocks and deploy to AWS with zero configuration.
//
// Some common getting-started blocks:
//   • KVStore          — key-value get/put/delete; with a schema and a key,
//                        records you list or query as a collection (DynamoDB)
//   • AuthBasic        — username/password auth with JWT sessions
//   • Realtime         — push updates to connected clients (WebSocket)
//   • FileBucket       — file uploads and downloads (S3)
//
// For the full list of blocks and how to use them, see:
//   node_modules/@aws-blocks/blocks/README.md
// ─────────────────────────────────────────────────────────────────────────────

const scope = new Scope('my-app');

// Every method below is a public API endpoint — no auth by default.
// To gate one, add an auth block and call auth.requireAuth(context) at the top.
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async greet(name: string) {
    return { message: `Hello, ${name}!`, timestamp: Date.now() };
  }
}));

// ─── Examples (uncomment to use) ─────────────────────────────────────────────
//
// import { AuthBasic, KVStore, Realtime } from '@aws-blocks/blocks';
// import { z } from 'zod';  // zod ships with new bare apps; when adding AWS Blocks to an existing project, run npm install zod
//
// // Auth (see node_modules/@aws-blocks/bb-auth-basic/README.md for full API):
// const auth = new AuthBasic(scope, 'auth', {
//   passwordPolicy: { minLength: 8 },
// });
// export const authApi = auth.createApi();
// // Frontend: Authenticator(authApi) from '@aws-blocks/blocks/ui'
// // Tests/programmatic:
// //   authApi.setAuthState({ action: 'signUp', username: '...', password: '...' })
// //   authApi.setAuthState({ action: 'signIn', username: '...', password: '...' })
// //   authApi.setAuthState({ action: 'signOut' })
// //   authApi.getAuthState() → { state: 'signedIn', user: { username } }
//
// // Data (Zod schema + declared key → typed records you list or query; a store fixes its key when you create it):
// const itemSchema = z.object({
//   userId: z.string(),
//   itemId: z.string(),
//   title: z.string(),
//   createdAt: z.number(),
// });
// const items = new KVStore(scope, 'items', {
//   schema: itemSchema,
//   key: { partitionKey: 'userId', sortKey: 'itemId' },
// });
//
// // Realtime:
// const rt = new Realtime(scope, 'live', {
//   namespaces: { items: Realtime.namespace(z.object({ action: z.string(), itemId: z.string() })) },
// });
//
// // Protected API method:
// export const api = new ApiNamespace(scope, 'api', (context) => ({
//   async createItem(title: string) {
//     const user = await auth.requireAuth(context);
//     const itemId = Date.now().toString(36);
//     const item = { userId: user.username, itemId, title, createdAt: Date.now() };
//     await items.put({ userId: user.username, itemId }, item);
//     await rt.publish('items', user.username, { action: 'created', itemId });
//     return item;
//   },
//   async listItems() {
//     const user = await auth.requireAuth(context);
//     return await Array.fromAsync(
//       items.query({ where: { userId: { equals: user.username } } }),
//       (entry) => entry.value,
//     );
//   },
// }));
