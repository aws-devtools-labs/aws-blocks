import { ApiNamespace, Scope } from '@aws-blocks/blocks';

// ─── IMPORTANT ───────────────────────────────────────────────────────────────
// Do NOT use local files, in-memory arrays, or local databases for persistence.
// Use Building Blocks for cloud persistence and other common cloud abstractions.
// They work locally with automatic mocks and deploy to AWS with zero configuration.
//
// Some common getting-started blocks:
//   • DistributedTable — structured data with indexes (DynamoDB)
//   • KVStore          — simple key-value get/put/delete
//   • Auth             — sign-in: email + password, social, OIDC, SAML
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
// import { Auth, DistributedTable, Realtime } from '@aws-blocks/blocks';
// import { z } from 'zod';  // add zod to package.json: npm install zod
//
// // Auth (see node_modules/@aws-blocks/bb-auth/README.md for full API):
// const auth = new Auth(scope, 'auth', {
//   session: { crossDomain: process.env.BLOCKS_SANDBOX === 'true' },
//   // Local dev only: print verification codes in the terminal (no email is sent).
//   codeDelivery: async (username, code, purpose) => console.log(`[auth] ${purpose} code for ${username}: ${code}`),
// });
// export const authApi = auth.createApi();
// // Frontend: Authenticator(authApi) from '@aws-blocks/blocks/ui'
// // Tests/programmatic (sign-up confirms the email with a 6-digit code):
// //   authApi.setAuthState({ action: 'signUp', username: '...', password: '...', email: '...' })
// //   authApi.setAuthState({ action: 'confirmSignUp', username: '...', code: '123456' })
// //   authApi.setAuthState({ action: 'autoSignIn', username: '...' })  → signed in
// //   authApi.setAuthState({ action: 'signIn', username: '...', password: '...' })
// //   authApi.setAuthState({ action: 'signOut' })
// //   authApi.getAuthState() → { state: 'signedIn', user: { username } }
//
// // Data (Zod schema → typed table with secondary indexes). Key per-user data on
// // the owner's `userSub`, which is stable for the user's lifetime:
// const itemSchema = z.object({
//   userSub: z.string(),
//   itemId: z.string(),
//   title: z.string(),
//   createdAt: z.number(),
// });
// const items = new DistributedTable(scope, 'items', {
//   schema: itemSchema,
//   key: { partitionKey: 'userSub', sortKey: 'itemId' },
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
//     const item = { userSub: user.userSub, itemId, title, createdAt: Date.now() };
//     await items.put(item);
//     await rt.publish('items', user.userSub, { action: 'created', itemId });
//     return item;
//   },
//   async listItems() {
//     const user = await auth.requireAuth(context);
//     return await Array.fromAsync(items.query({ where: { userSub: { equals: user.userSub } } }));
//   },
// }));
