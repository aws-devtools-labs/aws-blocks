import { ApiNamespace, Scope } from 'aws-cdk-blocks';

// ─── IMPORTANT ───────────────────────────────────────────────────────────────
// Do NOT use local files, in-memory arrays, or local databases for persistence.
// Use Building Blocks for cloud persistence and other common cloud abstractions.
// They work locally with automatic mocks and deploy to AWS with zero configuration.
//
// Some common getting-started blocks:
//   • KVStore          — key-value get/put/delete; with a schema and a key,
//                        records you list or query as a collection (DynamoDB)
//   • Auth             — sign-in: email + password, social, OIDC, SAML
//   • Realtime         — push updates to connected clients (WebSocket)
//   • FileBucket       — file uploads and downloads (S3)
//
// Building Block docs: npm run docs lists the blocks;
// npm run docs <Block>... prints their docs (--help for more)
// ─────────────────────────────────────────────────────────────────────────────

const scope = new Scope('my-app');

// Every method below is a public API endpoint — no auth by default.
// To gate one, add an auth block and call auth.requireAuth(context) at the top.
// Clients call `<export name>.<method>()`, so this one is `api.greet()`. For
// `orders.create()`, add `export const orders = new ApiNamespace(scope, 'orders', …)`
// rather than a `create` method here. The second argument is only a label.
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async greet(name: string) {
    return { message: `Hello, ${name}!`, timestamp: Date.now() };
  }
}));

// ─── Examples (uncomment to use) ─────────────────────────────────────────────
//
// import { Auth, KVStore, Realtime } from 'aws-cdk-blocks';
// import { z } from 'zod';  // zod ships with new bare apps; when adding CDK Blocks to an existing project, run npm install zod
//
// // Auth (full API: npm run docs Auth):
// const auth = new Auth(scope, 'auth', {
//   // Email sign-in, matched ignoring case (fixed when the user pool is created).
//   users: { signInWith: ['email'], caseSensitive: false },
//   // Local dev only: print verification codes in the terminal (no email is sent).
//   codeDelivery: async (username, code, purpose) => console.log(`[auth] ${purpose} code for ${username}: ${code}`),
// });
// export const authApi = auth.createApi();
// // Frontend: Authenticator(authApi) from 'aws-cdk-blocks/ui'
// // Tests/programmatic (sign-up confirms the email with a 6-digit code):
// //   authApi.setAuthState({ action: 'signUp', username: '...', password: '...', email: '...' })
// //   authApi.setAuthState({ action: 'confirmSignUp', username: '...', code: '123456' })
// //   authApi.setAuthState({ action: 'autoSignIn', username: '...' })  → signed in
// //   authApi.setAuthState({ action: 'signIn', username: '...', password: '...' })
// //   authApi.setAuthState({ action: 'signOut' })
// //   authApi.getAuthState() → { state: 'signedIn', user: { username } }
//
// // Data (Zod schema + declared key → typed records you list or query; a store fixes its key when you create it).
// // Key per-user data on the owner's `userSub`, which is stable for the user's lifetime:
// const itemSchema = z.object({
//   userSub: z.string(),
//   itemId: z.string(),
//   title: z.string(),
//   createdAt: z.number(),
// });
// const items = new KVStore(scope, 'items', {
//   schema: itemSchema,
//   key: { partitionKey: 'userSub', sortKey: 'itemId' }, // userSub + itemId together identify one item
//   // Another grouping or sort order is an index (an object keyed by name), not a different key:
//   indexes: { byCreatedAt: { partitionKey: 'userSub', sortKey: 'createdAt' } },
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
//     await items.put({ userSub: user.userSub, itemId }, item);
//     await rt.publish('items', user.userSub, { action: 'created', itemId });
//     return item;
//   },
//   async getItem(itemId: string) {
//     const user = await auth.requireAuth(context);
//     return await items.get({ userSub: user.userSub, itemId }); // the whole key as an object; null when absent
//   },
//   async listItems() {
//     const user = await auth.requireAuth(context);
//     return await Array.fromAsync(
//       items.query({ index: 'byCreatedAt', where: { userSub: { equals: user.userSub } }, order: 'desc' }), // newest first ('asc' | 'desc')
//       (entry) => entry.value,
//     );
//   },
// }));
