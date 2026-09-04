/**
 * Custom-resource Lambda that writes key/value entries into a CloudFront
 * KeyValueStore (KVS) at deploy time.
 *
 * Why a custom resource: CDK's `KeyValueStore` + `ImportSource` only seed the
 * store at CREATE time. A redeploy that changes the route table or the active
 * `buildId` needs a LIVE update of an existing store — which the CloudFormation
 * resource doesn't do. We perform it via the `cloudfront-keyvaluestore`
 * data-plane API (DescribeKeyValueStore → get ETag → UpdateKeys), the same
 * mechanism SST's `KvKeys` provider uses.
 *
 * Atomicity: this resource is wired (in the construct) to depend on the asset
 * `BucketDeployment`s, so the KV flip that activates a new `buildId` happens
 * only AFTER that build's assets are uploaded to S3 — preserving the
 * atomic-deploy cutover guarantee.
 *
 * Bundling: pre-bundled at BUILD time via `scripts/bundle-handlers.mjs`
 * (esbuild → `kv_keys_handler_bundle.mjs`) and shipped through
 * `Code.fromAsset`, NOT bundled at synth via `NodejsFunction`. Reason:
 * `@aws-sdk/client-cloudfront-keyvaluestore` is NOT in the Lambda runtime
 * baseline (it requires SigV4a signing), and a synth-time `NodejsFunction`
 * would resolve `projectRoot`/lockfile under `node_modules/` once this package
 * is installed from npm and fail. See `kv_keys.ts` for the asset wiring.
 */
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  UpdateKeysCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
// The cloudfront-keyvaluestore data-plane API signs with SigV4a (region-
// agnostic). The client uses @aws-sdk/signature-v4-multi-region, which loads
// the pure-JS SigV4a impl from @aws-sdk/signature-v4a at runtime via an
// OPTIONAL dynamic require — esbuild tree-shakes that away, so the Lambda fails
// with "Neither CRT nor JS SigV4a implementation is available". Importing it
// for side effects forces esbuild to bundle it and registers the JS signer.
import '@aws-sdk/signature-v4a';
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectTaggingCommand,
} from '@aws-sdk/client-s3';
import { BUILD_STATE_TAG_KEY, BUILD_STATE_SUPERSEDED } from './build_tags.js';

type Entries = Record<string, string>;

type Event = {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties: {
    KvsArn: string;
    /**
     * Hosting bucket that holds `builds/<id>/...`. Enables supersede-tagging of
     * the outgoing build at cutover (#480). Optional so older templates / unit
     * tests that omit it simply skip tagging.
     */
    BucketName?: string;
    /** JSON string of the desired key→value map. */
    Entries: string;
  };
  OldResourceProperties?: {
    Entries?: string;
  };
};

// CloudFront UpdateKeys limit: 50 keys OR 3 MB per request, whichever first.
const MAX_KEYS_PER_REQUEST = 50;
const MAX_BYTES_PER_REQUEST = 3 * 1024 * 1024;

// `sigv4aSigningRegionSet: ['*']` — KVS is a global service; the multi-region
// SigV4a signer needs a region set and '*' is the documented value for global.
const client = new CloudFrontKeyValueStoreClient({
  sigv4aSigningRegionSet: ['*'],
});

const s3 = new S3Client({});

/**
 * Extract the active buildId (`meta.b`) from a stringified entries map. The
 * KVS `meta` value is itself a JSON blob (`{"b":"<buildId>",...}`), so this
 * double-parses: outer map → `meta` string → `.b`. Returns undefined on any
 * malformed / missing input (callers treat undefined as "nothing to do").
 * Exported for unit testing.
 */
export function activeBuildId(entriesJson?: string): string | undefined {
  if (!entriesJson) return undefined;
  try {
    const entries = JSON.parse(entriesJson) as Entries;
    if (typeof entries.meta !== 'string') return undefined;
    const meta = JSON.parse(entries.meta) as { b?: unknown };
    return typeof meta.b === 'string' ? meta.b : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tag every object under `builds/<buildId>/` as SUPERSEDED so the
 * `DeleteOldBuilds` S3 lifecycle rule (which matches that tag) can reclaim it
 * (#480). Paginates the listing and tags each object with bounded concurrency
 * (15 in flight) to keep the cutover fast without overwhelming S3.
 *
 * Best-effort by contract: a failure here only means the old build lingers
 * UNtagged, which is safe — an untagged build is simply never matched by the
 * lifecycle rule, so it is not expired (it just isn't cleaned up yet). The NEW
 * (live) build is never passed here, so it is never a lifecycle target.
 *
 * Bounded by the custom-resource Lambda timeout: on a very large build the run
 * may not tag every object before timing out, leaving some objects untagged.
 * That is safe by the same contract — untagged objects are never expired, and
 * the live build is never tagged regardless.
 */
export async function supersedeBuild(
  bucket: string,
  buildId: string,
): Promise<void> {
  const CONCURRENCY = 15;
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `builds/${buildId}/`,
        ContinuationToken: token,
      }),
    );
    const keys = (page.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((key): key is string => typeof key === 'string');
    for (let i = 0; i < keys.length; i += CONCURRENCY) {
      const chunk = keys.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map((key) =>
          s3.send(
            new PutObjectTaggingCommand({
              Bucket: bucket,
              Key: key,
              Tagging: {
                TagSet: [{ Key: BUILD_STATE_TAG_KEY, Value: BUILD_STATE_SUPERSEDED }],
              },
            }),
          ),
        ),
      );
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

export type Put = { Key: string; Value: string };
export type Delete = { Key: string };

/**
 * Pure diff of desired vs. previous entries into the puts/deletes the route-
 * table flip needs: a put for every new-or-changed key, a delete for every key
 * that disappeared. Exported (with {@link batches}) so the load-bearing
 * cutover logic is unit-testable without the SDK.
 */
export function computeDiff(
  desired: Entries,
  previous: Entries,
): { puts: Put[]; deletes: Delete[] } {
  const puts = Object.entries(desired)
    .filter(([k, v]) => previous[k] !== v)
    .map(([Key, Value]) => ({ Key, Value }));
  const deletes = Object.keys(previous)
    .filter((k) => !(k in desired))
    .map((Key) => ({ Key }));
  return { puts, deletes };
}

/**
 * Split desired puts + deletes into UpdateKeys batches that respect the
 * 50-key / 3 MB-per-request ceiling. Exported for unit testing of the batch
 * boundaries (an off-by-one here would partial-apply the route table
 * mid-cutover and surface as an opaque deploy-time failure).
 */
export function* batches(
  puts: Put[],
  deletes: Delete[],
): Generator<{ puts: Put[]; deletes: Delete[] }> {
  let curPuts: typeof puts = [];
  let curDeletes: typeof deletes = [];
  let count = 0;
  let bytes = 0;
  const flush = function* (): Generator<{ puts: typeof puts; deletes: typeof deletes }> {
    if (curPuts.length || curDeletes.length) {
      yield { puts: curPuts, deletes: curDeletes };
      curPuts = [];
      curDeletes = [];
      count = 0;
      bytes = 0;
    }
  };
  for (const p of puts) {
    const sz = byteLen(p.Key) + byteLen(p.Value);
    if (count + 1 > MAX_KEYS_PER_REQUEST || bytes + sz > MAX_BYTES_PER_REQUEST) {
      yield* flush();
    }
    curPuts.push(p);
    count++;
    bytes += sz;
  }
  for (const d of deletes) {
    // Deletes are gated on the key COUNT only (not bytes, unlike puts above):
    // a delete carries just the key (≤512 B, the KVS key-size limit) and no
    // value, so a 50-key batch is at most ~25 KB — far under the 3 MB request
    // ceiling. Tracking bytes here would never change the batching outcome.
    if (count + 1 > MAX_KEYS_PER_REQUEST) {
      yield* flush();
    }
    curDeletes.push(d);
    count++;
  }
  yield* flush();
}

async function currentEtag(kvsArn: string): Promise<string> {
  const res = await client.send(
    new DescribeKeyValueStoreCommand({ KvsARN: kvsArn }),
  );
  if (!res.ETag) throw new Error('DescribeKeyValueStore returned no ETag');
  return res.ETag;
}

async function applyUpdate(
  kvsArn: string,
  desired: Entries,
  previous: Entries,
): Promise<void> {
  const { puts, deletes } = computeDiff(desired, previous);

  if (puts.length === 0 && deletes.length === 0) return;

  // ETag changes after every UpdateKeys, so refetch per batch.
  for (const batch of batches(puts, deletes)) {
    const etag = await currentEtag(kvsArn);
    await client.send(
      new UpdateKeysCommand({
        KvsARN: kvsArn,
        IfMatch: etag,
        Puts: batch.puts,
        Deletes: batch.deletes,
      }),
    );
  }
}

/**
 * The set of keys to drain on a Delete. CloudFormation does NOT populate
 * `OldResourceProperties` on Delete — the last-deployed props arrive in
 * `ResourceProperties` — so we must read `ResourceProperties.Entries`. Reading
 * `OldResourceProperties` here (as a previous version did) always yielded `{}`,
 * so nothing was ever drained. Exported for unit testing.
 */
export function deleteDrainSet(event: Event): Entries {
  const json = event.ResourceProperties?.Entries;
  return json ? (JSON.parse(json) as Entries) : {};
}

export async function handler(event: Event): Promise<{ PhysicalResourceId: string }> {
  const { KvsArn, Entries: entriesJson } = event.ResourceProperties;
  const physicalId = `kvkeys-${KvsArn.split('/').pop() ?? 'store'}`;

  if (event.RequestType === 'Delete') {
    await applyUpdate(KvsArn, {}, deleteDrainSet(event));
    return { PhysicalResourceId: physicalId };
  }

  const desired = JSON.parse(entriesJson) as Entries;
  // Previous state is taken from CloudFormation properties, not read from the
  // store: on Update, the prior template's Entries; on Create, empty (the store
  // is created fresh with no ImportSource). The diff of desired vs. previous
  // therefore only adds/overwrites keys and deletes keys the prior template
  // had; keys present in the store but in neither template are left untouched.
  const previous: Entries =
    event.RequestType === 'Update' && event.OldResourceProperties?.Entries
      ? (JSON.parse(event.OldResourceProperties.Entries) as Entries)
      : {};

  await applyUpdate(KvsArn, desired, previous);

  // #480: after the KVS pointer has flipped to the new build, tag the OUTGOING
  // build's objects as superseded so the `DeleteOldBuilds` lifecycle rule can
  // expire them. Order matters: we tag ONLY after applyUpdate() has committed
  // the flip, so a failure here can never affect the build that is now live
  // (the new build is never tagged). Best-effort — a failure leaves the old
  // build untagged (not expired), which is safe; we log and continue so a
  // transient S3 error never fails an otherwise-successful deploy.
  if (event.RequestType === 'Update' && event.ResourceProperties.BucketName) {
    const oldBuildId = activeBuildId(event.OldResourceProperties?.Entries);
    const newBuildId = activeBuildId(entriesJson);
    if (oldBuildId && oldBuildId !== newBuildId) {
      try {
        await supersedeBuild(event.ResourceProperties.BucketName, oldBuildId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `Failed to tag superseded build ${oldBuildId}; it will not be expired by ` +
            `the DeleteOldBuilds lifecycle rule until re-tagged. ${String(err)}`,
        );
      }
    }
  }

  return { PhysicalResourceId: physicalId };
}
