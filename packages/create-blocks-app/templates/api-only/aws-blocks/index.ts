/**
 * Backend — aws-blocks/index.ts
 *
 * A headless JSON API service — no frontend. The shape you start from when you
 * are building a backend for a mobile app, a CLI, or a third-party client.
 *
 * It ships a public health check plus an auth-gated CRUD resource (items) over a
 * DistributedTable, with per-user isolation and optimistic locking. Point any
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
import { ApiNamespace, Scope, AuthBasic, DistributedTable } from '@aws-blocks/blocks';
import { z } from 'zod';

const scope = new Scope('my-app');

// ─── Auth ────────────────────────────────────────────────────────────────────
const auth = new AuthBasic(scope, 'auth', {
  passwordPolicy: { minLength: 8 },
  crossDomain: process.env.BLOCKS_SANDBOX === 'true',
});
export const authApi = auth.createApi();

// ─── Data ────────────────────────────────────────────────────────────────────
// Zod schema = runtime validation + TypeScript types + DynamoDB table shape.
const itemSchema = z.object({
  owner: z.string(),        // partition key — per-user isolation
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

// ─── API ─────────────────────────────────────────────────────────────────────
export const api = new ApiNamespace(scope, 'api', (context) => ({

  /** Public — no auth. A liveness probe for load balancers and uptime checks. */
  async health() {
    return { status: 'ok' as const, timestamp: Date.now() };
  },

  /** Create an item owned by the caller. */
  async createItem(name: string, quantity: number = 1) {
    const user = await auth.requireAuth(context);
    const itemId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const item = {
      owner: user.username,
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
      items.query({ where: { owner: { equals: user.username } } }),
    );
  },

  /** Fetch one of the caller's items by id. */
  async getItem(itemId: string) {
    const user = await auth.requireAuth(context);
    const item = await items.get({ owner: user.username, itemId });
    if (!item) throw new Error('Item not found');
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
    const item = await items.get({ owner: user.username, itemId });
    if (!item) throw new Error('Item not found');
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
    const item = await items.get({ owner: user.username, itemId });
    if (!item) throw new Error('Item not found');
    await items.put(
      { ...item, quantity, version: expectedVersion + 1 },
      { ifFieldEquals: { version: expectedVersion } },
    );
    return { itemId, quantity, version: expectedVersion + 1 };
  },

  /** Delete one of the caller's items. */
  async deleteItem(itemId: string) {
    const user = await auth.requireAuth(context);
    await items.delete({ owner: user.username, itemId });
    return { success: true };
  },
}));
