// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import {
  batches,
  computeDiff,
  deleteDrainSet,
  activeBuildId,
  handler,
} from './kv_keys_handler.js';

// Regression for the Delete-path drain bug: CloudFormation does not send
// OldResourceProperties on Delete, so the keys to drain must come from
// ResourceProperties.Entries. A previous version read OldResourceProperties →
// always empty → nothing drained → orphaned KVS keys.
describe('kv_keys_handler — deleteDrainSet', () => {
  it('drains the keys from ResourceProperties.Entries (Delete has no OldResourceProperties)', () => {
    const entries = { meta: '{"b":"x"}', r0: '[]', d0: '[]' };
    const event = {
      RequestType: 'Delete' as const,
      ResourceProperties: { KvsArn: 'arn:kvs', Entries: JSON.stringify(entries) },
      // CloudFormation does NOT include this on Delete — present here as undefined
      OldResourceProperties: undefined,
    };
    assert.deepEqual(deleteDrainSet(event), entries);
  });

  it('returns {} when there are no entries', () => {
    const event = {
      RequestType: 'Delete' as const,
      ResourceProperties: { KvsArn: 'arn:kvs', Entries: '' },
    };
    assert.deepEqual(deleteDrainSet(event), {});
  });

  it('does NOT depend on OldResourceProperties (would be the bug)', () => {
    // Even if OldResourceProperties were somehow set, the drain set is driven
    // by ResourceProperties — the only field CFN populates on Delete.
    const real = { meta: '{}', h0: '[]' };
    const event = {
      RequestType: 'Delete' as const,
      ResourceProperties: { KvsArn: 'arn:kvs', Entries: JSON.stringify(real) },
      OldResourceProperties: { Entries: '{}' },
    };
    assert.deepEqual(deleteDrainSet(event), real);
  });
});

// The route-table flip is applied via batched UpdateKeys calls. An off-by-one
// at the 50-key boundary would partial-apply the table mid-cutover and surface
// as an opaque deploy-time failure — so the pure diff + batching are unit-tested
// at the boundaries here.
describe('kv_keys_handler — computeDiff', () => {
  it('puts new + changed keys, deletes removed keys, skips unchanged', () => {
    const desired = { a: '1', b: '2-new', c: '3' }; // a unchanged, b changed, c new
    const previous = { a: '1', b: '2-old', d: '4' }; // d removed
    const { puts, deletes } = computeDiff(desired, previous);
    assert.deepEqual(
      puts.sort((x, y) => x.Key.localeCompare(y.Key)),
      [
        { Key: 'b', Value: '2-new' },
        { Key: 'c', Value: '3' },
      ],
    );
    assert.deepEqual(deletes, [{ Key: 'd' }]);
  });

  it('is a no-op when desired equals previous', () => {
    const same = { a: '1', b: '2' };
    const { puts, deletes } = computeDiff(same, { ...same });
    assert.equal(puts.length, 0);
    assert.equal(deletes.length, 0);
  });
});

describe('kv_keys_handler — batches (50-key / 3 MB boundaries)', () => {
  const mkPuts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ Key: `k${i}`, Value: 'v' }));
  const collect = (
    puts: { Key: string; Value: string }[],
    deletes: { Key: string }[] = [],
  ) => [...batches(puts, deletes)];

  it('packs exactly 50 puts into a single batch', () => {
    const out = collect(mkPuts(50));
    assert.equal(out.length, 1);
    assert.equal(out[0].puts.length, 50);
  });

  it('splits 51 puts into 50 + 1', () => {
    const out = collect(mkPuts(51));
    assert.equal(out.length, 2);
    assert.equal(out[0].puts.length, 50);
    assert.equal(out[1].puts.length, 1);
  });

  it('counts puts AND deletes against the same 50-key ceiling (mixed crossing)', () => {
    // 30 puts + 30 deletes = 60 keys → must split (50 then 10), not one batch.
    const deletes = Array.from({ length: 30 }, (_, i) => ({ Key: `d${i}` }));
    const out = collect(mkPuts(30), deletes);
    const totalKeys = out.reduce(
      (n, b) => n + b.puts.length + b.deletes.length,
      0,
    );
    assert.equal(totalKeys, 60); // nothing dropped
    assert.ok(
      out.every((b) => b.puts.length + b.deletes.length <= 50),
      'no batch exceeds the 50-key ceiling',
    );
    assert.equal(out.length, 2);
  });

  it('flushes on the 3 MB byte ceiling before the key ceiling', () => {
    // Two ~2 MB puts (4 MB total) must land in separate batches even though
    // they are only 2 keys — the byte ceiling trips first.
    const big = 'x'.repeat(2 * 1024 * 1024);
    const out = collect([
      { Key: 'a', Value: big },
      { Key: 'b', Value: big },
    ]);
    assert.equal(out.length, 2);
  });

  it('yields nothing for an empty diff (no-op path)', () => {
    assert.equal(collect([], []).length, 0);
  });
});

// #480: the supersede-tagging at cutover keys off `activeBuildId`, which
// extracts the live buildId (`meta.b`) from the stringified entries map. The
// handler tags the OLD build superseded only when old !== new — so correct
// extraction is what guarantees the live build is never tagged (never expired).
describe('kv_keys_handler — activeBuildId (#480)', () => {
  const entriesJson = (b: string): string =>
    JSON.stringify({ r0: '[]', meta: JSON.stringify({ b, bp: '/', v: 1 }) });

  it('extracts meta.b from a stringified entries map', () => {
    assert.equal(activeBuildId(entriesJson('ms2z0nnb-6eec9615')), 'ms2z0nnb-6eec9615');
  });

  it('returns undefined for undefined / empty input', () => {
    assert.equal(activeBuildId(undefined), undefined);
    assert.equal(activeBuildId(''), undefined);
  });

  it('returns undefined when there is no meta key', () => {
    assert.equal(activeBuildId(JSON.stringify({ r0: '[]' })), undefined);
  });

  it('returns undefined when meta has no b', () => {
    assert.equal(activeBuildId(JSON.stringify({ meta: JSON.stringify({ bp: '/' }) })), undefined);
  });

  it('returns undefined on malformed JSON (never throws)', () => {
    assert.equal(activeBuildId('not json'), undefined);
    assert.equal(activeBuildId(JSON.stringify({ meta: 'not json' })), undefined);
  });

  it('distinguishes old vs new build so only a real cutover triggers tagging', () => {
    const oldB = activeBuildId(entriesJson('old-1111'));
    const newB = activeBuildId(entriesJson('new-2222'));
    assert.notEqual(oldB, newB);
    // Same build on both sides → no cutover → handler must not tag.
    assert.equal(activeBuildId(entriesJson('same-3333')), activeBuildId(entriesJson('same-3333')));
  });
});

// #480 F1: at cutover the handler must tag the OUTGOING build superseded AND
// clear the build-state tag on the INCOMING build. Leaving the incoming build
// tagged means a rollback that flips `meta.b` back to it hands the live build to
// the `DeleteOldBuilds` lifecycle rule — the original #480 bug.
describe('kv_keys_handler — cutover tagging (#480 F1)', () => {
  const OLD = 'old-1111';
  const NEW = 'new-2222';
  const BUCKET = 'hosting-bucket';
  const entriesJson = (b: string): string =>
    JSON.stringify({ r0: '[]', meta: JSON.stringify({ b, bp: '/', v: 1 }) });

  type Call = { name: string; Key?: string; Prefix?: string };

  const install = (): Call[] => {
    const calls: Call[] = [];
    mock.method(
      CloudFrontKeyValueStoreClient.prototype,
      'send',
      async (cmd: { constructor: { name: string } }) => {
        const name = cmd.constructor.name;
        calls.push({ name });
        return name === 'DescribeKeyValueStoreCommand' ? { ETag: 'etag-1' } : {};
      },
    );
    mock.method(
      S3Client.prototype,
      'send',
      async (cmd: { constructor: { name: string }; input: Record<string, string> }) => {
        const name = cmd.constructor.name;
        calls.push({ name, Key: cmd.input.Key, Prefix: cmd.input.Prefix });
        if (cmd instanceof ListObjectsV2Command) {
          const prefix = cmd.input.Prefix ?? '';
          return {
            Contents: [{ Key: `${prefix}index.html` }, { Key: `${prefix}assets/app.js` }],
            IsTruncated: false,
          };
        }
        return {};
      },
    );
    return calls;
  };

  const event = (
    RequestType: 'Create' | 'Update' | 'Delete',
    oldBuild: string | undefined,
    newBuild: string,
  ) => ({
    RequestType,
    ResourceProperties: {
      KvsArn: 'arn:aws:cloudfront::1:key-value-store/store-1',
      BucketName: BUCKET,
      Entries: entriesJson(newBuild),
    },
    OldResourceProperties: oldBuild ? { Entries: entriesJson(oldBuild) } : undefined,
  });

  afterEach(() => mock.restoreAll());

  const of = (calls: Call[], name: string): Call[] => calls.filter((c) => c.name === name);

  it('tags ONLY the outgoing build superseded and clears tags ONLY on the incoming build', async () => {
    const calls = install();
    await handler(event('Update', OLD, NEW));

    const puts = of(calls, 'PutObjectTaggingCommand');
    const dels = of(calls, 'DeleteObjectTaggingCommand');

    assert.ok(puts.length > 0, 'PutObjectTagging issued for the outgoing build');
    assert.ok(
      puts.every((c) => c.Key?.startsWith(`builds/${OLD}/`)),
      'every PutObjectTagging key is under the outgoing build prefix',
    );
    assert.ok(
      !puts.some((c) => c.Key?.startsWith(`builds/${NEW}/`)),
      'the incoming (live) build is NEVER tagged superseded',
    );

    assert.ok(dels.length > 0, 'DeleteObjectTagging issued for the incoming build');
    assert.ok(
      dels.every((c) => c.Key?.startsWith(`builds/${NEW}/`)),
      'every DeleteObjectTagging key is under the incoming build prefix',
    );
    assert.ok(
      !dels.some((c) => c.Key?.startsWith(`builds/${OLD}/`)),
      'the outgoing build never has its superseded tag cleared',
    );
  });

  it('issues neither tagging call on Create', async () => {
    const calls = install();
    await handler(event('Create', undefined, NEW));
    assert.equal(of(calls, 'PutObjectTaggingCommand').length, 0);
    assert.equal(of(calls, 'DeleteObjectTaggingCommand').length, 0);
  });

  it('issues neither tagging call on Delete', async () => {
    const calls = install();
    await handler(event('Delete', OLD, NEW));
    assert.equal(of(calls, 'PutObjectTaggingCommand').length, 0);
    assert.equal(of(calls, 'DeleteObjectTaggingCommand').length, 0);
  });

  it('issues neither tagging call on an Update that does not change the build (no cutover)', async () => {
    const calls = install();
    await handler(event('Update', 'same-3333', 'same-3333'));
    assert.equal(of(calls, 'PutObjectTaggingCommand').length, 0);
    assert.equal(of(calls, 'DeleteObjectTaggingCommand').length, 0);
  });
});
