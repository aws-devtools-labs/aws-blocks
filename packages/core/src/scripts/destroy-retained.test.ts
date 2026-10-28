// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';

import { assemblyStackNames, productionDestroyDeps } from './destroy.js';
import {
	type DestroyAttemptReport,
	describeStackIds,
	inspectDestroyAttempt,
	inspectStackDelete,
	isDependencyReason,
	isRetainedDependencyFailure,
	type StackResourceRef,
} from './destroy-retained.js';
import { runDestroyWithRetries, sandboxDestroyDeps } from './sandbox.js';

// A production stack retains its Aurora cluster. If the cluster's subnets and
// security group are deleted with the stack, CloudFormation fails them with
// "has dependencies" (the kept cluster's network interfaces are still in them)
// on every attempt. These pin that such a failure stops at once, that ordinary
// and throttled failures still retry, and that a successful destroy lists what
// it kept.

const SUBNET_REASON =
	"The subnet 'subnet-0abc' has dependencies and cannot be deleted. (Service: Ec2, Status Code: 400, Error Code: DependencyViolation)";

const cluster: StackResourceRef = {
	stackName: 'app',
	logicalId: 'mainCluster1A2B',
	type: 'AWS::RDS::DBCluster',
	physicalId: 'app-maincluster-xyz',
};
const subnetFailed: StackResourceRef = {
	stackName: 'app',
	logicalId: 'mainVpcisolatedSubnet1',
	type: 'AWS::EC2::Subnet',
	physicalId: 'subnet-0abc',
	reason: SUBNET_REASON,
};

const SG_REASON = 'resource sg-0lambda has a dependent object (Service: Ec2, Error Code: DependencyViolation)';
const clusterSg: StackResourceRef = {
	stackName: 'app',
	logicalId: 'mainClusterSecurityGroup',
	type: 'AWS::EC2::SecurityGroup',
	physicalId: 'sg-0cluster',
};
const lambdaSgFailed: StackResourceRef = {
	stackName: 'app',
	logicalId: 'BlocksLambdaSg',
	type: 'AWS::EC2::SecurityGroup',
	physicalId: 'sg-0lambda',
	reason: SG_REASON,
};

/** Capture console.error/console.log output for the duration of `fn`. */
async function captureConsole(fn: () => Promise<void>): Promise<{ errors: string; logs: string; warns: string }> {
	const errors = mock.method(console, 'error', () => {});
	const logs = mock.method(console, 'log', () => {});
	const warns = mock.method(console, 'warn', () => {});
	try {
		await fn();
	} finally {
		errors.mock.restore();
		logs.mock.restore();
		warns.mock.restore();
	}
	const join = (m: typeof errors) => m.mock.calls.map((c) => String(c.arguments[0])).join('\n');
	return { errors: join(errors), logs: join(logs), warns: join(warns) };
}

describe('isRetainedDependencyFailure', () => {
	it('is true when every failure is a dependency failure and a retained resource holds network interfaces', () => {
		assert.ok(isRetainedDependencyFailure({ failed: [subnetFailed], retained: [cluster] }));
	});

	it('is false with nothing retained (e.g. a Lambda network interface still detaching)', () => {
		assert.ok(!isRetainedDependencyFailure({ failed: [subnetFailed], retained: [] }));
	});

	it('is false when the retained resource holds no network interfaces', () => {
		const table = { stackName: 'app', logicalId: 'Table', type: 'AWS::DynamoDB::Table' };
		assert.ok(!isRetainedDependencyFailure({ failed: [subnetFailed], retained: [table] }));
	});

	it('is false when another failure is not a dependency failure', () => {
		const other = {
			...subnetFailed,
			logicalId: 'Bucket',
			type: 'AWS::S3::Bucket',
			reason: 'The bucket is not empty',
		};
		assert.ok(!isRetainedDependencyFailure({ failed: [subnetFailed, other], retained: [cluster] }));
	});

	it("is false when the retained resource's subnets are retained too (the failing network is another one)", () => {
		const keptSubnet = { stackName: 'app', logicalId: 'mainVpcSubnet', type: 'AWS::EC2::Subnet' };
		assert.ok(!isRetainedDependencyFailure({ failed: [subnetFailed], retained: [cluster, keptSubnet] }));
	});

	it("is false for a VPC Lambda's security group when the cluster's own security group is retained (customer VPC)", () => {
		assert.ok(!isRetainedDependencyFailure({ failed: [lambdaSgFailed], retained: [cluster, clusterSg] }));
	});

	it("is true for bb-data's own VPC when its subnet and security group were not retained", () => {
		const instance = { stackName: 'app', logicalId: 'mainWriter', type: 'AWS::RDS::DBInstance' };
		const subnetGroup = { stackName: 'app', logicalId: 'mainSubnets', type: 'AWS::RDS::DBSubnetGroup' };
		const sgFailed = { ...lambdaSgFailed, logicalId: 'mainClusterSecurityGroup', physicalId: 'sg-0cluster' };
		assert.ok(
			isRetainedDependencyFailure({
				failed: [subnetFailed, sgFailed],
				retained: [cluster, instance, subnetGroup],
			}),
		);
	});

	it('is false when a failed resource is not a subnet or security group', () => {
		const vpc = { ...subnetFailed, logicalId: 'mainVpc', type: 'AWS::EC2::VPC' };
		assert.ok(!isRetainedDependencyFailure({ failed: [vpc], retained: [cluster] }));
	});

	it('is false when nothing failed', () => {
		assert.ok(!isRetainedDependencyFailure({ failed: [], retained: [cluster] }));
	});

	it('recognizes the EC2 dependency reasons', () => {
		assert.ok(isDependencyReason(SUBNET_REASON));
		assert.ok(isDependencyReason('resource sg-0123 has a dependent object'));
		assert.ok(isDependencyReason('Error Code: DependencyViolation'));
		assert.ok(!isDependencyReason('Network interface is currently in use'));
		assert.ok(!isDependencyReason(undefined));
	});
});

describe('runDestroyWithRetries (retained resources)', () => {
	it('stops after one attempt on a failure caused by a retained resource, without emptying buckets or waiting', async () => {
		let attempts = 0;
		const steps: string[] = [];
		const out = await captureConsole(async () => {
			await assert.rejects(
				runDestroyWithRetries({
					runDestroy: () => {
						attempts++;
						throw new Error('DELETE_FAILED');
					},
					listStackNames: () => ['app'],
					emptyBuckets: async () => {
						steps.push('empty');
					},
					isThrottled: async () => false,
					inspectAttempt: async () => ({ failed: [subnetFailed], retained: [cluster] }),
					sleep: async () => {
						steps.push('sleep');
					},
				}),
				/DELETE_FAILED/,
			);
		});
		assert.strictEqual(attempts, 1);
		assert.deepStrictEqual(steps, []);
		assert.match(out.errors, /Destroy stopped/);
		assert.match(out.errors, /app\/mainVpcisolatedSubnet1 \(AWS::EC2::Subnet\) subnet-0abc: The subnet/);
		assert.match(
			out.errors,
			/Retained \(still running\):\n\s+- app\/mainCluster1A2B \(AWS::RDS::DBCluster\) app-maincluster-xyz/,
		);
	});

	it('counts a resource retained on an earlier attempt (CloudFormation reports it only once)', async () => {
		let attempts = 0;
		const reports: DestroyAttemptReport[] = [
			// Attempt 1 skips the cluster and fails on something transient...
			{ failed: [{ ...subnetFailed, reason: 'Network interface is currently in use' }], retained: [cluster] },
			// ...attempt 2 no longer sees the skip, but the subnet still has the cluster in it.
			{ failed: [subnetFailed], retained: [] },
		];
		await captureConsole(async () => {
			await assert.rejects(
				runDestroyWithRetries({
					runDestroy: () => {
						attempts++;
						throw new Error('DELETE_FAILED');
					},
					listStackNames: () => ['app'],
					emptyBuckets: async () => {},
					inspectAttempt: async () => reports[attempts - 1],
					sleep: async () => {},
				}),
			);
		});
		assert.strictEqual(attempts, 2);
	});

	it('still retries an ordinary dependency failure when nothing is retained (Lambda ENI detach)', async () => {
		let attempts = 0;
		const sleeps: number[] = [];
		await captureConsole(async () => {
			await runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					if (attempts < 3) throw new Error('DELETE_FAILED');
				},
				listStackNames: () => ['app'],
				emptyBuckets: async () => {},
				isThrottled: async () => false,
				inspectAttempt: async () => ({ failed: [subnetFailed], retained: [] }),
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			});
		});
		assert.strictEqual(attempts, 3);
		assert.deepStrictEqual(sleeps, [60_000, 120_000]);
	});

	it("retries a VPC Lambda's security group failure when the cluster and its security group are retained", async () => {
		let attempts = 0;
		const out = await captureConsole(async () => {
			await runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					if (attempts < 2) throw new Error('DELETE_FAILED');
				},
				listStackNames: () => ['app'],
				emptyBuckets: async () => {},
				inspectAttempt: async () => ({ failed: [lambdaSgFailed], retained: [cluster, clusterSg] }),
				sleep: async () => {},
			});
		});
		assert.strictEqual(attempts, 2);
		assert.doesNotMatch(out.errors, /Destroy stopped/);
	});

	it('reads the throttle from the inspected report, without a second scan', async () => {
		let throttleChecks = 0;
		const sleeps: number[] = [];
		let attempts = 0;
		await captureConsole(async () => {
			await runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					if (attempts < 2) throw new Error('DELETE_FAILED');
				},
				listStackNames: () => ['app'],
				emptyBuckets: async () => {},
				isThrottled: async () => {
					throttleChecks++;
					return false;
				},
				inspectAttempt: async () => ({
					failed: [{ ...subnetFailed, type: 'AWS::ApiGateway::RestApi', reason: 'Too Many Requests' }],
					retained: [],
				}),
				sleep: async (ms) => {
					sleeps.push(ms);
				},
				random: () => 0.5,
				now: () => 0,
			});
		});
		assert.strictEqual(throttleChecks, 0);
		assert.deepStrictEqual(sleeps, [45_000]);
	});

	it('falls back to isThrottled when the attempt cannot be inspected', async () => {
		let throttleChecks = 0;
		let attempts = 0;
		await captureConsole(async () => {
			await runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					if (attempts < 2) throw new Error('DELETE_FAILED');
				},
				listStackNames: () => ['app'],
				emptyBuckets: async () => {},
				isThrottled: async () => {
					throttleChecks++;
					return false;
				},
				inspectAttempt: async () => {
					throw new Error('AccessDenied');
				},
				sleep: async () => {},
			});
		});
		assert.strictEqual(throttleChecks, 1);
	});

	it('still uses the throttle backoff for a throttled failure, even with a retained resource', async () => {
		let attempts = 0;
		const sleeps: number[] = [];
		await captureConsole(async () => {
			await runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					if (attempts < 2) throw new Error('Too Many Requests (Service: ApiGateway, Status Code: 429)');
				},
				listStackNames: () => ['app'],
				emptyBuckets: async () => {},
				isThrottled: async () => true,
				inspectAttempt: async () => ({
					failed: [{ ...subnetFailed, type: 'AWS::ApiGateway::RestApi', reason: 'Too Many Requests' }],
					retained: [cluster],
				}),
				sleep: async (ms) => {
					sleeps.push(ms);
				},
				random: () => 0.5,
				now: () => 0,
			});
		});
		assert.strictEqual(attempts, 2);
		assert.deepStrictEqual(sleeps, [45_000]);
	});

	it('retries as usual when the failure cannot be inspected', async () => {
		let attempts = 0;
		const out = await captureConsole(async () => {
			await runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					if (attempts < 2) throw new Error('DELETE_FAILED');
				},
				listStackNames: () => ['app'],
				emptyBuckets: async () => {},
				inspectAttempt: async () => {
					throw new Error('AccessDenied');
				},
				sleep: async () => {},
			});
		});
		assert.strictEqual(attempts, 2);
		assert.doesNotMatch(out.errors, /Destroy stopped/);
	});

	it('lists the retained resources after a successful destroy', async () => {
		const listed: string[][] = [];
		const out = await captureConsole(async () => {
			await runDestroyWithRetries({
				runDestroy: () => {},
				listStackNames: () => ['app'],
				emptyBuckets: async () => {},
				inspectAttempt: async (stackNames) => {
					listed.push(stackNames);
					return { failed: [], retained: [cluster] };
				},
				reportRetained: true,
				sleep: async () => {},
				successLabel: 'Production stack',
			});
		});
		assert.deepStrictEqual(listed, [['app']]);
		assert.match(out.logs, /Production stack destroyed!/);
		assert.match(
			out.logs,
			/Kept 1 resource\(s\) because of their removal policy:\n\s+- app\/mainCluster1A2B \(AWS::RDS::DBCluster\) app-maincluster-xyz/,
		);
		assert.match(out.logs, /keep running, and are billed, until you delete them/);
	});

	it('passes the stack ids captured before the first attempt, and warns about a stack it could not read', async () => {
		const ids = new Map([['app', 'arn:app']]);
		const seen: unknown[] = [];
		let captures = 0;
		const out = await captureConsole(async () => {
			await runDestroyWithRetries({
				runDestroy: () => {},
				listStackNames: () => ['app', 'other'],
				emptyBuckets: async () => {},
				captureStackIds: async () => {
					captures++;
					return ids;
				},
				inspectAttempt: async (_names, _since, _prev, stackIds) => {
					seen.push(stackIds);
					return { failed: [], retained: [cluster], unread: ['other'] };
				},
				reportRetained: true,
				sleep: async () => {},
			});
		});
		assert.strictEqual(captures, 1);
		assert.deepStrictEqual(seen, [ids]);
		assert.match(out.warns, /could not read delete events for stack other; retained-resource summary unavailable/);
		assert.match(out.logs, /Kept 1 resource/);
	});

	it('prints no retained summary when nothing was retained, or without reportRetained', async () => {
		for (const reportRetained of [true, false]) {
			const out = await captureConsole(async () => {
				await runDestroyWithRetries({
					runDestroy: () => {},
					listStackNames: () => ['app'],
					emptyBuckets: async () => {},
					inspectAttempt: async () => ({ failed: [], retained: reportRetained ? [] : [cluster] }),
					reportRetained,
					sleep: async () => {},
				});
			});
			assert.doesNotMatch(out.logs, /Kept/);
		}
	});

	it('still succeeds when the retained summary cannot be read', async () => {
		const out = await captureConsole(async () => {
			await runDestroyWithRetries({
				runDestroy: () => {},
				listStackNames: () => ['app'],
				emptyBuckets: async () => {},
				inspectAttempt: async () => {
					throw new Error('AccessDenied');
				},
				reportRetained: true,
				sleep: async () => {},
			});
		});
		assert.match(out.logs, /destroyed!/);
	});
});

describe('destroy call sites (retained resources)', () => {
	it('both destroy paths stop on retained-resource failures; production also lists what it retained', () => {
		const sandbox = sandboxDestroyDeps('/app/aws-blocks/index.ts', {});
		assert.strictEqual(sandbox.inspectAttempt, inspectDestroyAttempt);
		assert.ok(!sandbox.reportRetained);
		const production = productionDestroyDeps({ cdkAppPath: 'cdk.ts', projectRoot: '/app' }, {});
		assert.strictEqual(production.inspectAttempt, inspectDestroyAttempt);
		assert.strictEqual(production.reportRetained, true);
		assert.strictEqual(typeof production.captureStackIds, 'function');
	});

	it('assemblyStackNames reads a fresh assembly from the cdk.json output directory, and ignores a stale one', () => {
		const root = mkdtempSync(join(tmpdir(), 'blocks-destroy-'));
		try {
			writeFileSync(join(root, 'cdk.json'), JSON.stringify({ app: 'x', output: 'out' }));
			mkdirSync(join(root, 'out'));
			const manifest = join(root, 'out', 'manifest.json');
			writeFileSync(
				manifest,
				JSON.stringify({
					artifacts: {
						AppStack: { type: 'aws:cloudformation:stack', properties: { stackName: 'my-app' } },
						Other: { type: 'aws:cloudformation:stack', properties: {} },
						Tree: { type: 'cdk:tree' },
					},
				}),
			);
			assert.deepStrictEqual(assemblyStackNames(root, Date.now() - 10_000), ['my-app', 'Other']);
			const old = new Date(Date.now() - 60_000);
			utimesSync(manifest, old, old);
			assert.strictEqual(assemblyStackNames(root, Date.now()), undefined);
			assert.strictEqual(assemblyStackNames(join(root, 'missing'), 0), undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

type FakeEvent = {
	Timestamp: Date;
	LogicalResourceId: string;
	PhysicalResourceId?: string;
	ResourceType: string;
	ResourceStatus: string;
	ResourceStatusReason?: string;
};

const MIN = 60_000;
const at = (min: number) => new Date(Date.UTC(2026, 9, 28, 11, 0) + min * MIN);
const SINCE = at(0).getTime();

/** One delete attempt of stack `s` that began at `startMin`, newest-first. */
function deleteEvents(startMin: number, outcome: 'failed' | 'complete'): FakeEvent[] {
	return [
		{
			Timestamp: at(startMin + 20),
			LogicalResourceId: 's',
			ResourceType: 'AWS::CloudFormation::Stack',
			ResourceStatus: outcome === 'failed' ? 'DELETE_FAILED' : 'DELETE_COMPLETE',
		},
		...(outcome === 'failed'
			? [
					{
						Timestamp: at(startMin + 10),
						LogicalResourceId: 'Subnet1',
						PhysicalResourceId: 'subnet-0abc',
						ResourceType: 'AWS::EC2::Subnet',
						ResourceStatus: 'DELETE_FAILED',
						ResourceStatusReason: SUBNET_REASON,
					},
				]
			: []),
		{
			Timestamp: at(startMin + 2),
			LogicalResourceId: 'Cluster',
			PhysicalResourceId: 'cluster-xyz',
			ResourceType: 'AWS::RDS::DBCluster',
			ResourceStatus: 'DELETE_SKIPPED',
		},
		{
			Timestamp: at(startMin),
			LogicalResourceId: 's',
			ResourceType: 'AWS::CloudFormation::Stack',
			ResourceStatus: 'DELETE_IN_PROGRESS',
		},
	];
}

/**
 * Fake CFN client: DescribeStackEvents by name or id, and ListStacks. A stack
 * listed in `deleted` is only found by its id (`id-<name>`), as after a delete.
 */
function fakeCfn(eventsByStack: Record<string, FakeEvent[]>, deleted: Record<string, Date> = {}) {
	const calls: string[] = [];
	const send = async (cmd: { constructor: { name: string }; input: { StackName?: string } }) => {
		calls.push(`${cmd.constructor.name}:${cmd.input.StackName ?? ''}`);
		if (cmd.constructor.name === 'DescribeStacksCommand') {
			const name = cmd.input.StackName ?? '';
			if (!eventsByStack[name] || deleted[name]) throw new Error(`Stack with id ${name} does not exist`);
			return { Stacks: [{ StackName: name, StackId: `id-${name}` }] };
		}
		if (cmd.constructor.name === 'ListStacksCommand') {
			return {
				StackSummaries: Object.entries(deleted).map(([name, when]) => ({
					StackName: name,
					StackId: `id-${name}`,
					DeletionTime: when,
					StackStatus: 'DELETE_COMPLETE',
				})),
			};
		}
		const ref = cmd.input.StackName ?? '';
		const name = ref.startsWith('id-') ? ref.slice(3) : ref;
		if (!eventsByStack[name] || (deleted[name] && !ref.startsWith('id-'))) {
			throw new Error(`Stack with id ${ref} does not exist`);
		}
		return { StackEvents: eventsByStack[name] };
	};
	return { cfn: { send } as unknown as CloudFormationClient, calls };
}

describe('inspectStackDelete', () => {
	it("reads this attempt's failed and retained resources from a stack whose delete failed", async () => {
		const { cfn } = fakeCfn({ s: deleteEvents(1, 'failed') });
		const report = await inspectStackDelete(cfn, ['s'], SINCE);
		assert.deepStrictEqual(report.failed, [
			{
				stackName: 's',
				logicalId: 'Subnet1',
				type: 'AWS::EC2::Subnet',
				physicalId: 'subnet-0abc',
				reason: SUBNET_REASON,
			},
		]);
		assert.deepStrictEqual(report.retained, [
			{ stackName: 's', logicalId: 'Cluster', type: 'AWS::RDS::DBCluster', physicalId: 'cluster-xyz' },
		]);
		assert.ok(isRetainedDependencyFailure(report));
	});

	it('reads a deleted stack by its id (found with ListStacks)', async () => {
		const { cfn, calls } = fakeCfn({ s: deleteEvents(1, 'complete') }, { s: at(21) });
		const report = await inspectStackDelete(cfn, ['s'], SINCE);
		assert.deepStrictEqual(report.failed, []);
		assert.deepStrictEqual(
			report.retained.map((r) => r.logicalId),
			['Cluster'],
		);
		assert.ok(calls.includes('DescribeStackEventsCommand:id-s'), calls.join(' '));
	});

	it('ignores an earlier deletion of a stack with the same name', async () => {
		const { cfn } = fakeCfn({ s: deleteEvents(-60, 'complete') }, { s: at(-40) });
		assert.deepStrictEqual(await inspectStackDelete(cfn, ['s'], SINCE), {
			failed: [],
			retained: [],
			unread: ['s'],
		});
	});

	it('reads a deleted stack by the id captured before the destroy, without ListStacks', async () => {
		const { cfn, calls } = fakeCfn({ s: deleteEvents(1, 'complete') }, { s: at(21) });
		const report = await inspectStackDelete(cfn, ['s'], SINCE, undefined, new Map([['s', 'id-s']]));
		assert.deepStrictEqual(
			report.retained.map((r) => r.logicalId),
			['Cluster'],
		);
		assert.deepStrictEqual(calls, ['DescribeStackEventsCommand:id-s']);
	});

	it('describeStackIds records the ids of the stacks that exist', async () => {
		const { cfn } = fakeCfn({ s: deleteEvents(1, 'failed') });
		assert.deepStrictEqual([...(await describeStackIds(cfn, ['s', 'gone']))], [['s', 'id-s']]);
	});

	it("ignores events from before this attempt's start", async () => {
		const { cfn } = fakeCfn({ s: deleteEvents(-30, 'failed') });
		assert.deepStrictEqual(await inspectStackDelete(cfn, ['s'], SINCE), { failed: [], retained: [] });
	});

	it('inspectDestroyAttempt calls no AWS API for no stacks', async () => {
		assert.deepStrictEqual(await inspectDestroyAttempt([], 0), { failed: [], retained: [] });
	});
});
