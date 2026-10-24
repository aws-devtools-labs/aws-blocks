// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import type { S3Client } from '@aws-sdk/client-s3';

import {
	destroyRetryClients,
	edgeStacksBlockedByReplicas,
	emptyBucket,
	emptySandboxBuckets,
	listStackBucketNames,
	runDestroyWithRetries,
	toDeleteObjects,
	topLevelStacks,
} from './sandbox.js';

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
			if (cmd.constructor.name === 'GetTemplateCommand') {
				return { TemplateBody: JSON.stringify({ Resources: { B1: { Type: 'AWS::S3::Bucket' }, B2: { Type: 'AWS::S3::Bucket' } } }) };
			}
			seen.push(cmd.input.NextToken);
			if (cmd.input.NextToken === undefined) {
				return {
					StackResourceSummaries: [
						{ ResourceType: 'AWS::S3::Bucket', LogicalResourceId: 'B1', PhysicalResourceId: 'b1' },
						{ ResourceType: 'AWS::Lambda::Function', LogicalResourceId: 'Fn', PhysicalResourceId: 'fn' },
					],
					NextToken: 't2',
				};
			}
			return { StackResourceSummaries: [{ ResourceType: 'AWS::S3::Bucket', LogicalResourceId: 'B2', PhysicalResourceId: 'b2' }] };
		};
		const cfn = { send } as unknown as CloudFormationClient;
		const buckets = await listStackBucketNames(cfn, 'stack');
		assert.deepStrictEqual(buckets, ['b1', 'b2']);
		assert.deepStrictEqual(seen, [undefined, 't2']); // paged exactly twice
	});

	// A bucket the stack's delete keeps (`RemovalPolicy.RETAIN`, the production
	// preset's default, or any other non-Delete DeletionPolicy) never blocks the
	// delete, so emptying it before a retry would only destroy the data the
	// policy exists to keep. Read the policy from the DEPLOYED template: it is
	// what CloudFormation acts on, even if the local code changed since.
	it('skips buckets the stack delete keeps, and buckets already deleted or skipped', async () => {
		const templateStages: unknown[] = [];
		const send: Send = async (cmd) => {
			if (cmd.constructor.name === 'GetTemplateCommand') {
				templateStages.push(cmd.input.TemplateStage);
				return {
					TemplateBody: JSON.stringify({
						Resources: {
							Hosting: { Type: 'AWS::S3::Bucket', DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' },
							Scratch: { Type: 'AWS::S3::Bucket' },
							UserFiles: { Type: 'AWS::S3::Bucket', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' },
							Logs: { Type: 'AWS::S3::Bucket', DeletionPolicy: 'RetainExceptOnCreate' },
							Gone: { Type: 'AWS::S3::Bucket' },
							Skipped: { Type: 'AWS::S3::Bucket' },
						},
					}),
				};
			}
			const bucket = (id: string, status = 'CREATE_COMPLETE') => ({
				ResourceType: 'AWS::S3::Bucket',
				LogicalResourceId: id,
				PhysicalResourceId: id.toLowerCase(),
				ResourceStatus: status,
			});
			return {
				StackResourceSummaries: [
					bucket('Hosting', 'DELETE_FAILED'),
					bucket('Scratch'),
					bucket('UserFiles'),
					bucket('Logs'),
					bucket('Gone', 'DELETE_COMPLETE'),
					bucket('Skipped', 'DELETE_SKIPPED'),
					bucket('NotInTemplate'),
				],
			};
		};
		const buckets = await listStackBucketNames({ send } as unknown as CloudFormationClient, 'stack');
		assert.deepStrictEqual(buckets, ['hosting', 'scratch']);
		assert.deepStrictEqual(templateStages, ['Processed']);
	});

	it('empties no bucket of a stack whose deployed template cannot be read', async (t) => {
		const warn = t.mock.method(console, 'warn', () => {});
		const send: Send = async (cmd) => {
			if (cmd.constructor.name === 'GetTemplateCommand') throw new Error('AccessDenied: cloudformation:GetTemplate');
			return {
				StackResourceSummaries: [{ ResourceType: 'AWS::S3::Bucket', LogicalResourceId: 'B', PhysicalResourceId: 'b' }],
			};
		};
		assert.deepStrictEqual(await listStackBucketNames({ send } as unknown as CloudFormationClient, 'stack'), []);
		assert.strictEqual(warn.mock.callCount(), 1);
		assert.match(String(warn.mock.calls[0].arguments[0]), /stack.*AccessDenied/);
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
			listStacks: () => {
				events.push('list');
				return [{ stackName: 'stackA' }, { stackName: 'stackB', region: 'us-east-1' }];
			},
			emptyBuckets: async (stacks) => {
				events.push(`empty:${stacks.map((st) => st.stackName).join(',')}`);
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

	it('lists the stacks again while the list is empty (a failed synth leaves no assembly)', async () => {
		let attempts = 0;
		let lists = 0;
		const emptied: string[] = [];
		await runDestroyWithRetries({
			runDestroy: () => {
				attempts++;
				if (attempts < 3) throw new Error('failed');
			},
			listStacks: () => {
				lists++;
				return lists === 1 ? [] : [{ stackName: 'stackA' }];
			},
			emptyBuckets: async (stacks) => {
				emptied.push(stacks.map((st) => st.stackName).join(','));
			},
			sleep: async () => {},
			retryDelays: [1, 1],
		});
		assert.strictEqual(lists, 2); // empty once, then resolved and kept
		assert.deepStrictEqual(emptied, ['stackA']);
	});

	it('does not empty or sleep when the first destroy succeeds', async () => {
		let emptied = false;
		let slept = false;
		let listed = false;
		await runDestroyWithRetries({
			runDestroy: () => {},
			listStacks: () => {
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
				listStacks: () => [],
				emptyBuckets: async () => {},
				sleep: async () => {},
				retryDelays: [1, 1],
			}),
			/still failing/,
		);
		assert.strictEqual(attempts, 3); // initial attempt + 2 retries
	});

	it('logs the default "Sandbox" label on success when none is given', async () => {
		const logs: string[] = [];
		const orig = console.log;
		console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
		try {
			await runDestroyWithRetries({
				runDestroy: () => {},
				listStacks: () => [],
				emptyBuckets: async () => {},
				sleep: async () => {},
			});
		} finally {
			console.log = orig;
		}
		assert.ok(logs.some((l) => l.includes('✅ Sandbox destroyed!')), logs.join('\n'));
	});

	it('logs a custom successLabel (production path reuse)', async () => {
		const logs: string[] = [];
		const orig = console.log;
		console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
		try {
			await runDestroyWithRetries({
				runDestroy: () => {},
				listStacks: () => [],
				emptyBuckets: async () => {},
				sleep: async () => {},
				successLabel: 'Production stack',
			});
		} finally {
			console.log = orig;
		}
		assert.ok(logs.some((l) => l.includes('✅ Production stack destroyed!')), logs.join('\n'));
		assert.ok(!logs.some((l) => l.includes('Sandbox')), 'must not log the sandbox label for a production destroy');
	});
});

// The retry's stack list must be the set `cdk destroy --all` deletes, by the
// name CloudFormation knows and in the stack's own Region. `cdk ls` prints
// construct paths (`Parent/Nested`) and also lists stacks inside a CDK Stage,
// and one default-Region client misses the us-east-1 Lambda@Edge stack.
describe('topLevelStacks', () => {
	it('lists the top-level stacks by stack name and Region, not stacks inside a Stage', (t) => {
		const dir = mkdtempSync(join(tmpdir(), 'bb-top-stacks-'));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		mkdirSync(join(dir, 'assembly-Stage'));
		const stack = (displayName: string, stackName: string, region: string) => ({
			type: 'aws:cloudformation:stack',
			environment: `aws://000000000000/${region}`,
			displayName,
			properties: { templateFile: `${stackName}.template.json`, stackName },
		});
		writeFileSync(
			join(dir, 'manifest.json'),
			JSON.stringify({
				version: '22.0.0',
				artifacts: {
					'my-app': stack('my-app', 'my-app', 'eu-west-1'),
					ParentNestedABCD1234: stack('Parent/Nested', 'ParentNestedABCD1234', 'eu-west-1'),
					'edge-lambda-stack-x': stack('edge-lambda-stack-x', 'edge-lambda-stack-x', 'us-east-1'),
					'agnostic-stack': {
						type: 'aws:cloudformation:stack',
						environment: 'aws://unknown-account/unknown-region',
						properties: { templateFile: 'agnostic.template.json' },
					},
					'assembly-Stage': { type: 'cdk:cloud-assembly', properties: { directoryName: 'assembly-Stage' } },
				},
			}),
		);
		writeFileSync(
			join(dir, 'assembly-Stage', 'manifest.json'),
			JSON.stringify({ version: '22.0.0', artifacts: { 'Stage-Staged': stack('Stage/Staged', 'Stage-Staged', 'eu-west-1') } }),
		);
		assert.deepStrictEqual(topLevelStacks(dir), [
			{ stackName: 'my-app', region: 'eu-west-1' },
			{ stackName: 'ParentNestedABCD1234', region: 'eu-west-1' },
			{ stackName: 'edge-lambda-stack-x', region: 'us-east-1' },
			{ stackName: 'agnostic-stack', region: undefined },
		]);
	});

	it('returns [] when there is no assembly', () => {
		assert.deepStrictEqual(topLevelStacks(join(tmpdir(), 'bb-no-such-assembly')), []);
	});
});

describe('emptySandboxBuckets', () => {
	it("lists each stack's buckets in that stack's own Region", async () => {
		const lookups: string[] = [];
		const emptied: string[] = [];
		const cfnFor = (region: string | undefined) => {
			const send: Send = async (cmd) => {
				lookups.push(`${cmd.input.StackName}@${region ?? 'default'}`);
				// Only the Region a stack lives in knows it.
				const home: Record<string, string> = { 'my-app': 'eu-west-1', 'edge-lambda-stack-x': 'us-east-1' };
				if (home[cmd.input.StackName] !== region) throw new Error(`Stack with id ${cmd.input.StackName} does not exist`);
				if (cmd.constructor.name === 'GetTemplateCommand') {
					return { TemplateBody: JSON.stringify({ Resources: { B: { Type: 'AWS::S3::Bucket' } } }) };
				}
				return {
					StackResourceSummaries: [
						{ ResourceType: 'AWS::S3::Bucket', LogicalResourceId: 'B', PhysicalResourceId: `${cmd.input.StackName}-bucket` },
					],
				};
			};
			return { send } as unknown as CloudFormationClient;
		};
		const s3Send: Send = async (cmd) => {
			if (cmd.constructor.name === 'ListObjectVersionsCommand') {
				emptied.push(cmd.input.Bucket);
				return {};
			}
			throw new Error(`unexpected ${cmd.constructor.name}`);
		};
		await emptySandboxBuckets(
			[
				{ stackName: 'my-app', region: 'eu-west-1' },
				{ stackName: 'edge-lambda-stack-x', region: 'us-east-1' },
			],
			{ cfnFor, s3: { send: s3Send } as unknown as S3Client },
		);
		assert.deepStrictEqual(lookups, [
			'my-app@eu-west-1',
			'my-app@eu-west-1',
			'edge-lambda-stack-x@us-east-1',
			'edge-lambda-stack-x@us-east-1',
		]);
		assert.deepStrictEqual(emptied, ['my-app-bucket', 'edge-lambda-stack-x-bucket']);
	});
});

// A Lambda@Edge function can't be deleted until CloudFront removes its
// replicas, hours after the distribution is gone. When the edge stack failed on
// that, retrying within minutes can't help, so the loop says so and stops.
describe('runDestroyWithRetries with a Lambda@Edge stack', () => {
	const stacks = [
		{ stackName: 'my-app', region: 'eu-west-1' },
		{ stackName: 'edge-lambda-stack-c8abc', region: 'us-east-1' },
	];

	function captureErrors(t: { after: (fn: () => void) => void }): string[] {
		const errors: string[] = [];
		const orig = console.error;
		console.error = (...a: unknown[]) => {
			errors.push(a.join(' '));
		};
		t.after(() => {
			console.error = orig;
		});
		return errors;
	}

	it('stops and says to re-run later when the edge stack failed on its replicated function', async (t) => {
		const errors = captureErrors(t);
		let attempts = 0;
		let slept = false;
		let emptied = false;
		const checked: string[][] = [];
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					throw new Error('edge-lambda-stack-c8abc: destroy failed');
				},
				listStacks: () => stacks,
				emptyBuckets: async () => {
					emptied = true;
				},
				edgeReplicaBlocked: async (given, attemptStartedAt) => {
					assert.ok(attemptStartedAt > 0 && attemptStartedAt <= Date.now());
					checked.push(given.map((st) => st.stackName));
					return ['edge-lambda-stack-c8abc'];
				},
				sleep: async () => {
					slept = true;
				},
				retryDelays: [1, 1],
			}),
			/edge-lambda-stack-c8abc: destroy failed/,
		);
		assert.strictEqual(attempts, 1);
		assert.strictEqual(slept, false);
		assert.strictEqual(emptied, false);
		assert.deepStrictEqual(checked, [['my-app', 'edge-lambda-stack-c8abc']]);
		const hint = errors.join('\n');
		assert.match(hint, /edge-lambda-stack-c8abc can't be deleted yet/);
		assert.match(hint, /few hours/);
		assert.match(hint, /Run `npm run sandbox:destroy` again later/);
	});

	it('names the given re-run command', async (t) => {
		const errors = captureErrors(t);
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					throw new Error('failed');
				},
				listStacks: () => stacks,
				emptyBuckets: async () => {},
				edgeReplicaBlocked: async () => ['edge-lambda-stack-c8abc'],
				sleep: async () => {},
				rerunCommand: 'npm run destroy',
			}),
		);
		assert.match(errors.join('\n'), /Run `npm run destroy` again later/);
	});

	it('keeps retrying when no edge stack is blocked by replicas, or when the check fails', async (t) => {
		captureErrors(t);
		for (const edgeReplicaBlocked of [
			async (): Promise<string[]> => [],
			async (): Promise<string[]> => {
				throw new Error('throttled');
			},
		]) {
			let attempts = 0;
			await runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					if (attempts === 1) throw new Error('failed');
				},
				listStacks: () => stacks,
				emptyBuckets: async () => {},
				edgeReplicaBlocked,
				sleep: async () => {},
				retryDelays: [1],
			});
			assert.strictEqual(attempts, 2);
		}
	});
});

describe('edgeStacksBlockedByReplicas', () => {
	const REPLICATED =
		'Lambda was unable to delete arn:aws:lambda:us-east-1:000000000000:function:fn:1 because it is a replicated ' +
		'function. Please see our documentation for Deleting Lambda@Edge Functions and Replicas.';

	/** A fake CloudFormation client per Region; records `stack@region` per call. */
	function fakeCfn(byStack: Record<string, unknown[] | Error>, calls: string[]) {
		return (region: string | undefined) => {
			const send: Send = async (cmd) => {
				calls.push(`${cmd.input.StackName}@${region ?? 'default'}`);
				const pages = byStack[cmd.input.StackName];
				if (pages instanceof Error) throw pages;
				const index = cmd.input.NextToken === undefined ? 0 : Number(cmd.input.NextToken);
				return { StackResourceSummaries: pages[index], NextToken: index + 1 < pages.length ? String(index + 1) : undefined };
			};
			return { send } as unknown as CloudFormationClient;
		};
	}

	const since = Date.parse('2026-10-23T12:00:00Z');
	const failed = (reason: string, at: string) => ({
		ResourceType: 'AWS::Lambda::Function',
		ResourceStatus: 'DELETE_FAILED',
		ResourceStatusReason: reason,
		LastUpdatedTimestamp: new Date(at),
	});

	it('returns the edge stacks whose function delete failed as replicated, looked up in their own Region', async () => {
		const calls: string[] = [];
		const blocked = await edgeStacksBlockedByReplicas(
			[
				{ stackName: 'my-app', region: 'eu-west-1' },
				{ stackName: 'edge-lambda-stack-a', region: 'us-east-1' },
				{ stackName: 'edge-lambda-stack-b', region: 'us-east-1' },
				{ stackName: 'edge-lambda-stack-c', region: 'us-east-1' },
				{ stackName: 'edge-lambda-stack-d', region: 'us-east-1' },
			],
			since,
			fakeCfn(
				{
					// second page carries the replicated failure, from this attempt
					'edge-lambda-stack-a': [
						[{ ResourceType: 'AWS::IAM::Role', ResourceStatus: 'DELETE_COMPLETE' }],
						[failed(REPLICATED, '2026-10-23T12:03:00Z')],
					],
					// failed for another reason: the ordinary retries apply
					'edge-lambda-stack-b': [[failed('Rate exceeded', '2026-10-23T12:03:00Z')]],
					'edge-lambda-stack-c': new Error('Stack with id edge-lambda-stack-c does not exist'),
					// a replicated failure left over from an earlier run: not this attempt's
					'edge-lambda-stack-d': [[failed(REPLICATED, '2026-10-23T08:00:00Z')]],
				},
				calls,
			),
		);
		assert.deepStrictEqual(blocked, ['edge-lambda-stack-a']);
		// my-app is not an edge stack, so it is never looked up
		assert.deepStrictEqual(calls, [
			'edge-lambda-stack-a@us-east-1',
			'edge-lambda-stack-a@us-east-1',
			'edge-lambda-stack-b@us-east-1',
			'edge-lambda-stack-c@us-east-1',
			'edge-lambda-stack-d@us-east-1',
		]);
	});

	it('returns [] without a call when there is no edge stack', async () => {
		const calls: string[] = [];
		assert.deepStrictEqual(await edgeStacksBlockedByReplicas([{ stackName: 'my-app' }], since, fakeCfn({}, calls)), []);
		assert.deepStrictEqual(calls, []);
	});
});

describe('destroyRetryClients', () => {
	it("uses the Region CDK deploys to, and a stack's own Region when it has one", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), 'bb-retry-clients-'));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		// cdk.json's region comes first in CDK's lookup, before AWS_REGION.
		writeFileSync(join(dir, 'cdk.json'), JSON.stringify({ app: 'x', region: 'eu-west-3' }));
		const clients = await destroyRetryClients(dir);
		const regionOf = (client: { config: { region: () => Promise<string> | string } }) =>
			Promise.resolve(client.config.region());
		assert.strictEqual(await regionOf(clients.cfnFor(undefined)), 'eu-west-3');
		assert.strictEqual(await regionOf(clients.cfnFor('us-east-1')), 'us-east-1');
		assert.strictEqual(clients.cfnFor('us-east-1'), clients.cfnFor('us-east-1')); // one client per Region
		assert.strictEqual(await regionOf(clients.s3), 'eu-west-3');
	});
});
