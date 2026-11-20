// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Source for the S3 cache plugin written into the user's
 * `server/plugins/_hosting-cache.mjs` before `nuxt build`. Inlined as
 * a string so it ships inside the compiled package (TypeScript only
 * copies `.ts`/`.js`, not `.mjs`).
 *
 * At runtime this plugin mounts an S3-backed driver at the `cache`
 * mount point so Nitro's `swr`/`isr` route rules and
 * `defineCachedHandler` calls share storage across Lambda containers.
 *
 * Auth uses the AWS SDK credential chain (Lambda execution role); no
 * static keys.
 *
 * Env vars set by the L3 construct:
 *   - `HOSTING_NITRO_CACHE_BUCKET` — S3 bucket name
 *   - `HOSTING_NITRO_CACHE_REGION` — bucket region
 *
 * Honours user-defined cache mounts: if anything is already mounted
 * at `cache`, this plugin no-ops so it never overrides user choice.
 */
export const NITRO_CACHE_PLUGIN_SOURCE = `import { defineNitroPlugin, useStorage } from '#imports';
import { createRequire } from 'node:module';

// 2.3 — externalize @aws-sdk/client-s3 from Nitro's bundle. The
// Lambda Node 20 runtime ships @aws-sdk/* under /var/runtime/node_modules
// (~16 MB unzipped). A static \`import { ... } from '@aws-sdk/client-s3'\`
// would force Nitro/Rollup to bundle the SDK into the server zip,
// burning bundle size + cold-start time when the runtime already has
// the same package. createRequire() defers the resolution to Lambda
// runtime, so Nitro's bundler can't see the import target.
//
// The actual \`require()\` call is intentionally INSIDE \`defineNitroPlugin\`
// (after the env-var early return). Why: Nitro's prerenderer evaluates
// every plugin during \`nuxt build\` to compile the routing/storage
// layer. If the SDK require ran at module-load time, prerender would
// try to resolve \`@aws-sdk/client-s3\` from the user's project — where
// it isn't installed — and the build would fail with
// "Cannot find module '@aws-sdk/client-s3'". Deferring to inside the
// plugin function (after the bucket/region check) means prerender
// hits the early return path and never touches the SDK; Lambda
// runtime is the only environment where bucket/region are set, and
// it has the SDK pre-installed.
const lazyRequireS3 = () => createRequire(import.meta.url)('@aws-sdk/client-s3');

const bucket = process.env.HOSTING_NITRO_CACHE_BUCKET;
const region = process.env.HOSTING_NITRO_CACHE_REGION;

const keyToS3 = (key) => key.replace(/:/g, '/');
const log = (msg) =>
  process.stderr.write(\`[hosting:cache] \${msg}\\n\`);

const makeDriver = ({ client, S3Cmds }) => ({
  name: 'hosting-s3-cache',

  async hasItem(key) {
    try {
      await client.send(
        new S3Cmds.HeadObjectCommand({ Bucket: bucket, Key: keyToS3(key) }),
      );
      return true;
    } catch (err) {
      if (err?.name === 'NotFound' || err?.name === 'NoSuchKey') return false;
      throw err;
    }
  },

  async getItem(key) {
    try {
      const res = await client.send(
        new S3Cmds.GetObjectCommand({ Bucket: bucket, Key: keyToS3(key) }),
      );
      const body = await res.Body.transformToString();
      try {
        return JSON.parse(body);
      } catch {
        return body;
      }
    } catch (err) {
      if (err?.name === 'NoSuchKey' || err?.name === 'NotFound') return null;
      throw err;
    }
  },

  async setItem(key, value) {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    await client.send(
      new S3Cmds.PutObjectCommand({
        Bucket: bucket,
        Key: keyToS3(key),
        Body: body,
        ContentType: 'application/json',
      }),
    );
  },

  async removeItem(key) {
    await client.send(
      new S3Cmds.DeleteObjectCommand({ Bucket: bucket, Key: keyToS3(key) }),
    );
  },

  async getKeys(base) {
    // ListObjectsV2 returns at most 1000 keys per call. Page through
    // with ContinuationToken so a cache larger than 1000 entries
    // doesn't silently truncate (which would make getKeys/clear miss
    // objects and leak storage).
    const prefix = base ? keyToS3(base) : undefined;
    const keys = [];
    let continuationToken;
    do {
      const res = await client.send(
        new S3Cmds.ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        keys.push(obj.Key.replace(/\\//g, ':'));
      }
      continuationToken = res.IsTruncated
        ? res.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return keys;
  },

  async clear(base) {
    // Batch-delete via DeleteObjects (up to 1000 keys/call) instead of
    // one DeleteObject per key. Unbounded per-key deletes can hit S3's
    // ~3,500 DELETE/s per-prefix limit on a large cache and are far
    // slower. getKeys already paginated, so this handles >1000 keys.
    const keys = await this.getKeys(base);
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await client.send(
        new S3Cmds.DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((k) => ({ Key: keyToS3(k) })) },
        }),
      );
    }
  },
});

export default defineNitroPlugin((nitroApp) => {
  if (!bucket || !region) {
    log(
      'HOSTING_NITRO_CACHE_BUCKET / _REGION not set — cache stays in-memory ' +
        '(per-Lambda-container, not shared)',
    );
    return;
  }

  const storage = useStorage();

  // Don't override a cache mount the user has already configured.
  const existingMounts = storage.getMounts?.('cache') ?? [];
  const userOwned = existingMounts.some(
    (m) => m.driver?.name && m.driver.name !== 'memory' && m.driver.name !== 'hosting-s3-cache',
  );
  if (userOwned) {
    log(
      'cache mount already owned by user-configured driver, skipping S3 backend',
    );
    return;
  }

  // Lazy-resolve the SDK only at runtime (Lambda has it under
  // /var/runtime/node_modules; build-time prerender doesn't, but
  // also doesn't reach this branch because env vars aren't set).
  const S3Cmds = lazyRequireS3();
  const client = new S3Cmds.S3Client({ region });
  const s3CacheDriver = makeDriver({ client, S3Cmds });
  storage.mount('cache', s3CacheDriver);
  log(\`mounted S3 cache backend (bucket=\${bucket})\`);

  // Plugin order in Nitro is determined by filename. Our plugin runs
  // first (the leading underscore puts \`_hosting-cache\` ahead in
  // alphabetical order), but a later user-named plugin (e.g.
  // \`zz-storage.ts\`) can rebind the \`cache\` mount AFTER we set it.
  // Without re-binding, the framework's SWR/ISR rules silently write
  // to the user's later mount instead of S3 — cache hit rate drops to
  // 0% across Lambda containers and the symptom is "SWR doesn't work
  // in production" with no error.
  //
  // We watch for displacement via Nitro's \`storage:mounts\` hook (when
  // available) and a per-request fallback. After the first remount we
  // flip \`settled\` so the request-hook fast-path becomes a single
  // boolean check on the hot path — \`getMounts\` and the array scan are
  // skipped on every subsequent request.
  let settled = false;
  const remountIfDisplaced = () => {
    if (settled) return;
    const mounts = storage.getMounts?.('cache') ?? [];
    const ours = mounts.some(
      (m) => m.driver?.name === 'hosting-s3-cache',
    );
    if (ours) return;
    log(
      'cache mount was displaced after init by another plugin — re-binding S3 backend',
    );
    storage.mount('cache', s3CacheDriver);
    settled = true;
  };

  // Nitro exposes \`hooks.hook\` on the runtime app instance. Bind to
  // \`storage:mounts\` (newer Nitro fires this when a mount changes)
  // AND a generic \`request\` hook fallback that runs the same check
  // at the top of each request. \`settled\` short-circuits subsequent
  // calls once the mount is restored.
  if (nitroApp?.hooks?.hook) {
    try {
      nitroApp.hooks.hook('storage:mounts', remountIfDisplaced);
      
    } catch {
      // hook name not supported by this Nitro version — fall back to
      // the request-time check below.
    }
    try {
      nitroApp.hooks.hook('request', remountIfDisplaced);
      
    } catch {
      // ignore — best-effort
    }
  }
});
`;
