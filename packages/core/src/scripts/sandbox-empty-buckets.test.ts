// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import type { S3Client } from '@aws-sdk/client-s3';

import { emptyBucket, listStackBucketNames, runDestroyWithRetries, toDeleteObjects } from './sandbox.js';

// The teardown bucket-emptying must delete BOTH live versions and delete
// markers — a versioned bucket left with either still blocks `cdk destroy`.
// This is the exact combination that, done wrong, silently no-ops.
describe('toDeleteObjects', () => {
	it('combines versions and delete markers', () => {
		const out = toDeleteObjects({
			Versions: [
				{ Key: 'a', VersionId: 'v1' },
				{ Key: 'b', VersionId: 'v2' },
			],
			DeleteMarkers: [{ Key: 'a', VersionId: 'dm1' }],
		});
		assert.deepStrictEqual(out, [
			{ Key: 'a', VersionId: 'v1' },
			{ Key: 'b', VersionId: 'v2' },
			{ Key: 'a', VersionId: 'dm1' },
		]);
	});

	it('returns [] for an empty bucket (no Versions/DeleteMarkers keys)', () => {
		assert.deepStrictEqual(toDeleteObjects({}), []);
	});

	it('tolerates only versions or only delete markers', () => {
		assert.deepStrictEqual(toDeleteObjects({ Versions: [{ Key: 'x', VersionId: 'v' }] }), [
			{ Key: 'x', VersionId: 'v' },
		]);
		assert.deepStrictEqual(toDeleteObjects({ DeleteMarkers: [{ Key: 'y', VersionId: 'd' }] }), [
			{ Key: 'y', VersionId: 'd' },
		]);
	});

	it('drops entries without a Key rather than emitting a bad DeleteObjects payload', () => {
		assert.deepStrictEqual(toDeleteObjects({ Versions: [{ VersionId: 'orphan' }] }), []);
	});
});

// A fake AWS client: routes on the command class name and returns queued/canned
// responses. Cast to the real client type — this is test plumbing, not customer code.
type Send = (cmd: { constructor: { name: string }; input: any }) => Promise<any>;

describe('listStackBucketNames', () => {
	it('follows NextToken across pages and returns only S3 buckets', async () => {
		const seen: Array<string | undefined> = [];
		const send: Send = async (cmd) => {
			seen.push(cmd.input.NextToken);
			if (cmd.input.NextToken === undefined) {
				return {
					StackResourceSummaries: [
						{ ResourceType: 'AWS::S3::Bucket', PhysicalResourceId: 'b1' },
						{ ResourceType: 'AWS::Lambda::Function', PhysicalResourceId: 'fn' },
					],
					NextToken: 't2',
				};
			}
			return { StackResourceSummaries: [{ ResourceType: 'AWS::S3::Bucket', PhysicalResourceId: 'b2' }] };
		};
		const cfn = { send } as unknown as CloudFormationClient;
		const buckets = await listStackBucketNames(cfn, 'stack');
		assert.deepStrictEqual(buckets, ['b1', 'b2']);
		assert.deepStrictEqual(seen, [undefined, 't2']); // paged exactly twice
	});
});

describe('emptyBucket', () => {
	it('deletes versions + markers, re-lists, and stops when empty', async () => {
		let lists = 0;
		const deletePayloads: unknown[] = [];
		const send: Send = async (cmd) => {
			if (cmd.constructor.name === 'ListObjectVersionsCommand') {
				lists++;
				return lists === 1
					? { Versions: [{ Key: 'a', VersionId: 'v1' }], DeleteMarkers: [{ Key: 'a', VersionId: 'd1' }] }
					: {};
			}
			if (cmd.constructor.name === 'DeleteObjectsCommand') {
				deletePayloads.push(cmd.input.Delete.Objects);
				return {};
			}
			throw new Error(`unexpected ${cmd.constructor.name}`);
		};
		await emptyBucket({ send } as unknown as S3Client, 'bucket');
		assert.strictEqual(lists, 2); // listed, deleted, re-listed → empty
		assert.deepStrictEqual(deletePayloads, [
			[
				{ Key: 'a', VersionId: 'v1' },
				{ Key: 'a', VersionId: 'd1' },
			],
		]);
	});

	it('stops (no infinite loop) when DeleteObjects reports Errors', async () => {
		let lists = 0;
		let deletes = 0;
		const send: Send = async (cmd) => {
			if (cmd.constructor.name === 'ListObjectVersionsCommand') {
				lists++;
				return { Versions: [{ Key: 'locked', VersionId: 'v1' }] };
			}
			if (cmd.constructor.name === 'DeleteObjectsCommand') {
				deletes++;
				return { Errors: [{ Key: 'locked', Code: 'AccessDenied' }] };
			}
			throw new Error(`unexpected ${cmd.constructor.name}`);
		};
		await emptyBucket({ send } as unknown as S3Client, 'bucket');
		assert.strictEqual(lists, 1); // did NOT re-list after Errors
		assert.strictEqual(deletes, 1);
	});
});

// The sev2 fix is the wiring: on a destroy failure, buckets get emptied BEFORE
// the retry. runDestroyWithRetries takes its side effects as deps so we can
// exercise that ordering without spawning cdk.
describe('runDestroyWithRetries', () => {
	it('empties buckets before retrying a failed destroy', async () => {
		const events: string[] = [];
		let attempts = 0;
		await runDestroyWithRetries({
			runDestroy: () => {
				attempts++;
				events.push(`destroy#${attempts}`);
				if (attempts === 1) throw new Error('bucket not empty');
			},
			listStackNames: () => {
				events.push('list');
				return ['stackA', 'stackB'];
			},
			emptyBuckets: async (names) => {
				events.push(`empty:${names.join(',')}`);
			},
			sleep: async () => {
				events.push('sleep');
			},
			retryDelays: [1],
		});
		assert.strictEqual(attempts, 2);
		// buckets emptied (with the resolved stack names) before the retry destroy
		assert.deepStrictEqual(events, ['destroy#1', 'list', 'empty:stackA,stackB', 'sleep', 'destroy#2']);
	});

	it('does not empty or sleep when the first destroy succeeds', async () => {
		let emptied = false;
		let slept = false;
		let listed = false;
		await runDestroyWithRetries({
			runDestroy: () => {},
			listStackNames: () => {
				listed = true;
				return [];
			},
			emptyBuckets: async () => {
				emptied = true;
			},
			sleep: async () => {
				slept = true;
			},
		});
		assert.strictEqual(emptied, false);
		assert.strictEqual(slept, false);
		assert.strictEqual(listed, false);
	});

	it('throws after exhausting retries', async () => {
		let attempts = 0;
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					throw new Error('still failing');
				},
				listStackNames: () => [],
				emptyBuckets: async () => {},
				sleep: async () => {},
				retryDelays: [1, 1],
			}),
			/still failing/,
		);
		assert.strictEqual(attempts, 3); // initial attempt + 2 retries
	});
});
