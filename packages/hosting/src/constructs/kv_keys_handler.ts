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
 * Bundled with its SDK dependency via esbuild (NodejsFunction), because
 * `@aws-sdk/client-cloudfront-keyvaluestore` is NOT part of the Lambda runtime
 * baseline (it requires SigV4a signing).
 */
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  ListKeysCommand,
  UpdateKeysCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
// The cloudfront-keyvaluestore data-plane API signs with SigV4a (region-
// agnostic). The client uses @aws-sdk/signature-v4-multi-region, which loads
// the pure-JS SigV4a impl from @aws-sdk/signature-v4a at runtime via an
// OPTIONAL dynamic require — esbuild tree-shakes that away, so the Lambda fails
// with "Neither CRT nor JS SigV4a implementation is available". Importing it
// for side effects forces esbuild to bundle it and registers the JS signer.
import '@aws-sdk/signature-v4a';

type Entries = Record<string, string>;

type Event = {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties: {
    KvsArn: string;
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

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Split desired puts + deletes into UpdateKeys batches that respect the
 * 50-key / 3 MB-per-request ceiling.
 */
function* batches(
  puts: { Key: string; Value: string }[],
  deletes: { Key: string }[],
): Generator<{ puts: typeof puts; deletes: typeof deletes }> {
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
  const puts = Object.entries(desired)
    .filter(([k, v]) => previous[k] !== v)
    .map(([Key, Value]) => ({ Key, Value }));
  const deletes = Object.keys(previous)
    .filter((k) => !(k in desired))
    .map((Key) => ({ Key }));

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

/** Read every existing key so Delete can fully drain the store. */
async function listAll(kvsArn: string): Promise<Entries> {
  const out: Entries = {};
  let next: string | undefined;
  do {
    const res = await client.send(
      new ListKeysCommand({ KvsARN: kvsArn, NextToken: next }),
    );
    for (const item of res.Items ?? []) {
      if (item.Key !== undefined) out[item.Key] = item.Value ?? '';
    }
    next = res.NextToken;
  } while (next);
  return out;
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
  // On Update, diff against the previous template's entries; on Create, diff
  // against what's actually in the store (handles re-create over a dirty store).
  const previous: Entries =
    event.RequestType === 'Update' && event.OldResourceProperties?.Entries
      ? (JSON.parse(event.OldResourceProperties.Entries) as Entries)
      : await listAll(KvsArn);

  await applyUpdate(KvsArn, desired, previous);
  return { PhysicalResourceId: physicalId };
}
