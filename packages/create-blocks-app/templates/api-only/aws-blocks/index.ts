/**
 * Backend — aws-blocks/index.ts
 *
 * A headless JSON API service — no frontend. The shape you start from when you
 * are building a backend for a mobile app, a CLI, or a third-party client.
 *
 * It ships a public health check plus an auth-gated CRUD resource (items) over a
 * DistributedTable, with per-user isolation and optimistic locking, and
 * auth-gated presigned file URLs scoped to each user's own files. Point any
 * client at the RPC endpoint; there is no web UI to serve.
 *
 * ─── IMPORTANT ───────────────────────────────────────────────────────────────
 * Do NOT use local files, in-memory arrays, or local databases for persistence.
 * Use Building Blocks for cloud persistence and other common cloud abstractions.
 * They work locally with automatic mocks and deploy to AWS with zero configuration.
 *
 * For the full list of blocks and how to use them, see:
 *   node_modules/@aws-blocks/blocks/README.md
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { ApiNamespace, ApiError, Scope, Auth, DistributedTable, FileBucket, RawRoute } from '@aws-blocks/blocks';
import { z } from 'zod';

const scope = new Scope('my-app');

// ─── Auth ────────────────────────────────────────────────────────────────────
// Email + password sign-in (see node_modules/@aws-blocks/bb-auth/README.md).
// Sign-up confirms the email address with a 6-digit code; once the caller
// submits it they are signed in automatically. On AWS, Cognito emails the code.
const auth = new Auth(scope, 'auth', {
  // Users sign in with their email, matched ignoring case. Both are fixed when
  // the user pool is created, and this is also the pool shape Amplify's client
  // libraries expect, so a frontend can later sign in with them too.
  users: { signInWith: ['email'], caseSensitive: false },
  // Local dev only: no email is sent, so print the code in the `npm run dev`
  // terminal. Ignored on AWS.
  codeDelivery: async (username, code, purpose) => {
    console.log(`[auth] ${purpose} code for ${username}: ${code}`);
  },
});
export const authApi = auth.createApi();

// ─── Data ────────────────────────────────────────────────────────────────────
// Zod schema = runtime validation + TypeScript types + DynamoDB table shape.
const itemSchema = z.object({
  owner: z.string(),        // partition key — the owner's userSub (per-user isolation)
  itemId: z.string(),       // sort key — unique within a user
  name: z.string(),
  quantity: z.number(),
  version: z.number(),      // optimistic locking — incremented on each update
  createdAt: z.number(),
});

const items = new DistributedTable(scope, 'items', {
  schema: itemSchema,
  key: { partitionKey: 'owner', sortKey: 'itemId' },
});

// ─── Files ─────────────────────────────────────────────────────────────────
// Object storage for binary files. A headless client uploads/downloads via
// presigned URLs: ask the API for a URL, then PUT/GET the bytes directly.
// Versioning is on (the FileBucket default), so an overwritten or deleted file
// can be restored from its previous version.
const files = new FileBucket(scope, 'files');

/**
 * Content types `createUploadUrl` will sign for. The presigned PUT only succeeds
 * with the Content-Type it was signed with, so this list is what a client can
 * store. Extend it for the file types your app accepts.
 */
const ALLOWED_UPLOAD_TYPES = new Set(['text/plain', 'application/json', 'application/pdf', 'image/png', 'image/jpeg']);

/** FileBucket path under the signed-in user's own prefix (`/` in a user id is encoded). */
const userPath = (userSub: string, path: string) => `users/${encodeURIComponent(userSub)}/${path}`;

// ─── Health probe ────────────────────────────────────────────────────────────
// Public — no auth. Load balancers and uptime monitors send a plain `GET` and
// can't speak JSON-RPC, so the probe is a RawRoute (full HTTP control) rather
// than an API method. It touches no data. See RawRoute in
// node_modules/@aws-blocks/blocks/README.md for path parameters and wildcards.
new RawRoute(scope, 'healthz', {
  method: 'GET',
  path: '/healthz',
  handler: async (context) => {
    context.response.headers.set('Content-Type', 'application/json');
    // A cached "ok" would hide an outage from the probe.
    context.response.headers.set('Cache-Control', 'no-store');
    context.response.send({ status: 'ok', timestamp: Date.now() });
  },
});

// ─── API ─────────────────────────────────────────────────────────────────────
export const api = new ApiNamespace(scope, 'api', (context) => ({

  /** Public — no auth. The liveness check for RPC clients; probes that send a plain GET use `/healthz` above. */
  async health() {
    return { status: 'ok' as const, timestamp: Date.now() };
  },

  /**
   * Mint a presigned URL to upload a file under the caller's own prefix. The
   * client PUTs the bytes directly to the returned URL with the same
   * Content-Type. No bytes pass through the API itself. A presigned URL is a
   * bearer credential for that one object, so only a signed-in caller gets one,
   * and only for their own files.
   */
  async createUploadUrl(path: string, contentType: string) {
    const user = await auth.requireAuth(context);
    if (!ALLOWED_UPLOAD_TYPES.has(contentType)) {
      throw new ApiError(`Unsupported content type: ${contentType}`, 400, { name: 'UnsupportedContentTypeException' });
    }
    return { url: await files.putUrl(userPath(user.userSub, path), { contentType }) };
  },

  /** Mint a presigned URL to download one of the caller's files. The client GETs the bytes directly. */
  async createDownloadUrl(path: string) {
    const user = await auth.requireAuth(context);
    return { url: await files.getUrl(userPath(user.userSub, path)) };
  },

  /** Create an item owned by the caller. */
  async createItem(name: string, quantity: number = 1) {
    const user = await auth.requireAuth(context);
    const itemId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const item = {
      owner: user.userSub,
      itemId,
      name,
      quantity,
      version: 1,
      createdAt: Date.now(),
    };
    await items.put(item);
    return item;
  },

  /** List the caller's items. */
  async listItems() {
    const user = await auth.requireAuth(context);
    return await Array.fromAsync(
      items.query({ where: { owner: { equals: user.userSub } } }),
    );
  },

  /** Fetch one of the caller's items by id. */
  async getItem(itemId: string) {
    const user = await auth.requireAuth(context);
    const item = await items.get({ owner: user.userSub, itemId });
    if (!item) throw new ApiError('Item not found', 404, { name: 'ItemNotFoundException' });
    return item;
  },

  /**
   * Update an item's quantity with optimistic locking. This is the convenience
   * variant: it self-reads the current version and conditions the write on it, so
   * the `ifFieldEquals` precondition only guards against a writer that raced between
   * this `get` and `put`. For caller-supplied compare-and-swap (the raw primitive),
   * use `setQuantity`. `ifFieldEquals` detects a concurrent write; on conflict it
   * throws and the caller should re-read and retry.
   */
  async updateQuantity(itemId: string, quantity: number) {
    const user = await auth.requireAuth(context);
    const item = await items.get({ owner: user.userSub, itemId });
    if (!item) throw new ApiError('Item not found', 404, { name: 'ItemNotFoundException' });
    await items.put(
      { ...item, quantity, version: item.version + 1 },
      { ifFieldEquals: { version: item.version } },
    );
    return { success: true };
  },

  /**
   * Compare-and-swap: update the quantity only if the item is still at
   * `expectedVersion`. If another writer moved on first, the `ifFieldEquals`
   * precondition fails and the block throws `ConditionalCheckFailedException`
   * (HTTP 409) — catch it with `isBlocksError(e, DistributedTableErrors.ConditionalCheckFailed)`,
   * re-read, and retry. This is the raw optimistic-lock primitive `updateQuantity`
   * builds on, exposed so a client can implement its own retry policy.
   */
  async setQuantity(itemId: string, quantity: number, expectedVersion: number) {
    const user = await auth.requireAuth(context);
    const item = await items.get({ owner: user.userSub, itemId });
    if (!item) throw new ApiError('Item not found', 404, { name: 'ItemNotFoundException' });
    await items.put(
      { ...item, quantity, version: expectedVersion + 1 },
      { ifFieldEquals: { version: expectedVersion } },
    );
    return { itemId, quantity, version: expectedVersion + 1 };
  },

  /** Delete one of the caller's items. */
  async deleteItem(itemId: string) {
    const user = await auth.requireAuth(context);
    await items.delete({ owner: user.userSub, itemId });
    return { success: true };
  },
}));
