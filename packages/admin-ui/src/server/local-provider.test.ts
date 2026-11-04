// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { LocalDataProvider } from './local-provider.js';

describe('LocalDataProvider', () => {
	let tmpDir: string;

	function makeProject(files: Record<string, string>): string {
		tmpDir = join(tmpdir(), `admin-ui-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tmpDir, '.blocks'), { recursive: true });
		mkdirSync(join(tmpDir, '.blocks-sandbox'), { recursive: true });
		for (const [rel, content] of Object.entries(files)) {
			writeFileSync(join(tmpDir, rel), content);
		}
		return tmpDir;
	}

	afterEach(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	it('reads project name from package.json and stack name from .blocks/config.json', async () => {
		const root = makeProject({
			'package.json': JSON.stringify({ name: 'my-blocks-app' }),
			'.blocks/config.json': JSON.stringify({ stackId: 'my-blocks-app-abc123' }),
		});
		const meta = await new LocalDataProvider(root).getProjectMeta();
		assert.strictEqual(meta.projectName, 'my-blocks-app');
		assert.strictEqual(meta.projectRoot, root);
		assert.deepStrictEqual(
			meta.stages.map((s) => s.name),
			['sandbox', 'production'],
		);
		assert.strictEqual(meta.stages[0].stackName, 'my-blocks-app-abc123');
	});

	it('falls back to the directory name without package.json', async () => {
		const root = makeProject({});
		const meta = await new LocalDataProvider(root).getProjectMeta();
		assert.ok(meta.projectName.startsWith('admin-ui-provider-test-'));
		assert.strictEqual(meta.stages[0].stackName, undefined);
	});

	it('returns an empty deployment list when no history file exists', async () => {
		const root = makeProject({});
		assert.deepStrictEqual(await new LocalDataProvider(root).listDeployments(), []);
	});

	it('parses deploy-history.jsonl newest-first, skipping corrupt lines', async () => {
		const lines = [
			JSON.stringify({ id: 'd1', stage: 'sandbox', startedAt: '2026-08-01T10:00:00Z', status: 'SUCCEEDED' }),
			'{ not json',
			JSON.stringify({ id: 'd2', stage: 'production', startedAt: '2026-08-02T10:00:00Z', status: 'FAILED' }),
		];
		const root = makeProject({ '.blocks/deploy-history.jsonl': `${lines.join('\n')}\n` });
		const deployments = await new LocalDataProvider(root).listDeployments();
		assert.deepStrictEqual(
			deployments.map((d) => d.id),
			['d2', 'd1'],
		);
		assert.strictEqual(deployments[0].source, 'deploy-history');
	});

	it('merges records by id — terminal record wins over IN_PROGRESS', async () => {
		const lines = [
			JSON.stringify({ id: 'd1', stage: 'production', startedAt: '2026-08-18T10:00:00Z', status: 'IN_PROGRESS' }),
			JSON.stringify({ id: 'd2', stage: 'production', startedAt: '2026-08-18T11:00:00Z', status: 'IN_PROGRESS' }),
			JSON.stringify({
				id: 'd1',
				stage: 'production',
				startedAt: '2026-08-18T10:00:00Z',
				finishedAt: '2026-08-18T10:03:00Z',
				status: 'SUCCEEDED',
			}),
		];
		const root = makeProject({ '.blocks/deploy-history.jsonl': lines.join('\n') });
		const deployments = await new LocalDataProvider(root).listDeployments();
		// d2 has no terminal record (process died mid-deploy) and stays IN_PROGRESS.
		assert.deepStrictEqual(
			deployments.map((d) => [d.id, d.status]),
			[
				['d2', 'IN_PROGRESS'],
				['d1', 'SUCCEEDED'],
			],
		);
	});

	it('skips records without an id', async () => {
		const lines = [
			JSON.stringify({ stage: 'sandbox', startedAt: '2026-08-01T10:00:00Z', status: 'SUCCEEDED' }),
			JSON.stringify({ id: 'ok', stage: 'sandbox', startedAt: '2026-08-02T10:00:00Z', status: 'SUCCEEDED' }),
		];
		const root = makeProject({ '.blocks/deploy-history.jsonl': lines.join('\n') });
		const deployments = await new LocalDataProvider(root).listDeployments();
		assert.deepStrictEqual(
			deployments.map((d) => d.id),
			['ok'],
		);
	});

	it('filters by stage', async () => {
		const lines = [
			JSON.stringify({ id: 'd1', stage: 'sandbox', startedAt: '2026-08-01T10:00:00Z', status: 'SUCCEEDED' }),
			JSON.stringify({ id: 'd2', stage: 'production', startedAt: '2026-08-02T10:00:00Z', status: 'SUCCEEDED' }),
		];
		const root = makeProject({ '.blocks/deploy-history.jsonl': lines.join('\n') });
		const deployments = await new LocalDataProvider(root).listDeployments('production');
		assert.deepStrictEqual(
			deployments.map((d) => d.id),
			['d2'],
		);
	});

	describe('listDeployments backfill', () => {
		const cfnEvents = (stackName: string) => [
			{
				Timestamp: new Date('2026-08-10T10:00:00Z'),
				LogicalResourceId: stackName,
				ResourceType: 'AWS::CloudFormation::Stack',
				ResourceStatus: 'CREATE_IN_PROGRESS',
				ResourceStatusReason: 'User Initiated',
			},
			{
				Timestamp: new Date('2026-08-10T10:05:00Z'),
				LogicalResourceId: stackName,
				ResourceType: 'AWS::CloudFormation::Stack',
				ResourceStatus: 'CREATE_COMPLETE',
			},
		];

		it('adds reconstructed episodes for deploys missing from history', async () => {
			const historyLine = JSON.stringify({
				id: 'h1',
				stage: 'production',
				startedAt: '2026-08-15T10:00:00Z',
				finishedAt: '2026-08-15T10:04:00Z',
				status: 'SUCCEEDED',
			});
			const root = makeProject({
				'.blocks/deploy-history.jsonl': historyLine,
				'.blocks/config.json': JSON.stringify({ stackId: 'my-app' }),
			});
			const provider = new LocalDataProvider(root, async (stackName) => cfnEvents(stackName));
			const deployments = await provider.listDeployments();
			assert.deepStrictEqual(
				deployments.map((d) => [d.source, d.status]),
				[
					['deploy-history', 'SUCCEEDED'],
					['cloudformation-events', 'SUCCEEDED'],
				],
			);
		});

		it('drops episodes overlapping a history record of the same stage', async () => {
			const historyLine = JSON.stringify({
				id: 'h1',
				stage: 'production',
				startedAt: '2026-08-10T10:00:30Z',
				finishedAt: '2026-08-10T10:04:30Z',
				status: 'SUCCEEDED',
			});
			const root = makeProject({
				'.blocks/deploy-history.jsonl': historyLine,
				'.blocks/config.json': JSON.stringify({ stackId: 'my-app' }),
			});
			const provider = new LocalDataProvider(root, async (stackName) => cfnEvents(stackName));
			const deployments = await provider.listDeployments();
			assert.deepStrictEqual(
				deployments.map((d) => d.id),
				['h1'],
			);
		});

		it('silently skips backfill when the event fetch fails', async () => {
			const root = makeProject({
				'.blocks/deploy-history.jsonl': '',
				'.blocks/config.json': JSON.stringify({ stackId: 'my-app' }),
			});
			const provider = new LocalDataProvider(root, async () => {
				throw new Error('no credentials');
			});
			assert.deepStrictEqual(await provider.listDeployments(), []);
		});

		it('drill-down finds backfilled episodes by id', async () => {
			const failedEvents = [
				{
					Timestamp: new Date('2026-08-10T10:00:00Z'),
					LogicalResourceId: 'my-app-prod',
					ResourceType: 'AWS::CloudFormation::Stack',
					ResourceStatus: 'UPDATE_IN_PROGRESS',
					ResourceStatusReason: 'User Initiated',
				},
				{
					Timestamp: new Date('2026-08-10T10:02:00Z'),
					LogicalResourceId: 'Table',
					ResourceType: 'AWS::DynamoDB::Table',
					ResourceStatus: 'CREATE_FAILED',
					ResourceStatusReason: 'resource already exists',
				},
				{
					Timestamp: new Date('2026-08-10T10:05:00Z'),
					LogicalResourceId: 'my-app-prod',
					ResourceType: 'AWS::CloudFormation::Stack',
					ResourceStatus: 'UPDATE_ROLLBACK_COMPLETE',
				},
			];
			const root = makeProject({
				'.blocks/deploy-history.jsonl': '',
				'.blocks/config.json': JSON.stringify({ stackId: 'my-app' }),
			});
			const provider = new LocalDataProvider(root, async () => failedEvents);
			const [episode] = await provider.listDeployments();
			assert.strictEqual(episode.status, 'ROLLED_BACK');
			const detail = await provider.getDeployment(episode.id);
			assert.strictEqual(detail?.rootCause?.logicalResourceId, 'Table');
		});
	});

	describe('listLogGroups', () => {
		const lambdaResource = {
			LogicalResourceId: 'Handler',
			PhysicalResourceId: 'my-app-Handler-AB12',
			ResourceType: 'AWS::Lambda::Function',
		};

		function providerWith(opts: {
			files: Record<string, string>;
			resources?: () => Promise<(typeof lambdaResource)[]>;
			metadata?: (
				names: string[],
			) => Promise<Map<string, { retentionDays: number | null; storedBytes?: number }>>;
			onResources?: (stackName: string, region?: string) => void;
		}) {
			const root = makeProject(opts.files);
			return new LocalDataProvider(
				root,
				async () => [],
				async (stackName, region) => {
					opts.onResources?.(stackName, region);
					return opts.resources ? opts.resources() : [lambdaResource];
				},
				async (names) => (opts.metadata ? opts.metadata(names) : new Map()),
			);
		}

		it("discovers groups in the region the stage's own outputs file names", async () => {
			const record = JSON.stringify({
				id: 'd1',
				stage: 'sandbox',
				startedAt: '2026-08-18T10:00:00Z',
				status: 'SUCCEEDED',
				stackName: 'recorded-sandbox-stack',
				// Deliberately a DIFFERENT region from the outputs file below. The
				// recorded value is a re-derivation that can disagree with the region
				// CDK deployed to, so nothing resolves a region from it any more.
				region: 'ap-southeast-2',
			});
			let requested: { stackName?: string; region?: string } = {};
			const provider = providerWith({
				files: {
					'.blocks/deploy-history.jsonl': record,
					'.blocks-sandbox/outputs.json': JSON.stringify({
						'recorded-sandbox-stack': {
							ApiUrl: 'https://abc.execute-api.us-east-1.amazonaws.com/prod/',
						},
					}),
				},
				onResources: (stackName, region) => {
					requested = { stackName, region };
				},
			});
			const result = await provider.listLogGroups('sandbox');
			assert.deepStrictEqual(requested, { stackName: 'recorded-sandbox-stack', region: 'us-east-1' });
			assert.strictEqual(result.groupsSource, 'cloudformation');
			assert.deepStrictEqual(
				result.groups.map((g) => g.name),
				['/aws/lambda/my-app-Handler-AB12'],
			);
			assert.strictEqual(result.awsContext?.regionSource, 'outputs');
		});

		it('applies enrichment metadata including null retention (never expires)', async () => {
			const provider = providerWith({
				files: { '.blocks/config.json': JSON.stringify({ stackId: 'my-app' }) },
				metadata: async (names) => new Map(names.map((n) => [n, { retentionDays: null, storedBytes: 2048 }])),
			});
			const result = await provider.listLogGroups('production');
			assert.strictEqual(result.groups[0].retentionDays, null);
			assert.strictEqual(result.groups[0].storedBytes, 2048);
		});

		it('reports unavailable with classification when resource listing fails', async () => {
			const provider = providerWith({
				files: { '.blocks/config.json': JSON.stringify({ stackId: 'my-app' }) },
				resources: async () => {
					throw new Error('The security token included in the request is expired');
				},
			});
			const result = await provider.listLogGroups('production');
			assert.strictEqual(result.groupsSource, 'unavailable');
			assert.strictEqual(result.groupsErrorCode, 'CREDENTIALS_EXPIRED');
			assert.deepStrictEqual(result.groups, []);
		});

		it('reports unavailable when no stack target is resolvable', async () => {
			const provider = providerWith({ files: {} });
			const result = await provider.listLogGroups('sandbox');
			assert.strictEqual(result.groupsSource, 'unavailable');
			assert.match(result.groupsError ?? '', /stack name/i);
		});
	});

	describe('searchLogs', () => {
		const lambdaResource = {
			LogicalResourceId: 'Handler',
			PhysicalResourceId: 'my-fn',
			ResourceType: 'AWS::Lambda::Function',
		};
		const ghostResource = {
			LogicalResourceId: 'NeverLogged',
			PhysicalResourceId: 'ghost-fn',
			ResourceType: 'AWS::Lambda::Function',
		};

		function searchProvider(opts: {
			runner: (options: { logGroupNames: string[]; queryString: string }) => Promise<{
				rows: Record<string, string>[];
				scannedBytes?: number;
				matchedEvents?: number;
			}>;
			metadataFor?: string[];
		}) {
			const root = makeProject({ '.blocks/config.json': JSON.stringify({ stackId: 'my-app' }) });
			return new LocalDataProvider(
				root,
				async () => [],
				async () => [lambdaResource, ghostResource],
				async () =>
					new Map((opts.metadataFor ?? ['/aws/lambda/my-fn']).map((n) => [n, { retentionDays: null }])),
				opts.runner,
			);
		}

		it('queries only groups confirmed to exist and maps rows to entries', async () => {
			let queried: string[] = [];
			let query = '';
			const provider = searchProvider({
				runner: async (options) => {
					queried = options.logGroupNames;
					query = options.queryString;
					return {
						rows: [
							{
								'@timestamp': '2026-08-18 10:00:00.000',
								'@message': JSON.stringify({
									level: 'error',
									message: 'boom',
									logger: 'app',
									timestamp: 't',
								}),
								'@log': 'acct:/aws/lambda/my-fn',
							},
						],
						scannedBytes: 12345,
						matchedEvents: 1,
					};
				},
			});
			const result = await provider.searchLogs({ stage: 'production', level: 'error' });
			assert.deepStrictEqual(queried, ['/aws/lambda/my-fn']); // ghost-fn excluded
			assert.match(query, /filter level = 'error'/);
			assert.strictEqual(result.searchSource, 'insights');
			assert.strictEqual(result.entries[0].message, 'boom');
			assert.deepStrictEqual(result.stats, { scannedBytes: 12345, matchedEvents: 1 });
		});

		it('falls back to all groups when enrichment confirmed none', async () => {
			let queried: string[] = [];
			const provider = searchProvider({
				metadataFor: [],
				runner: async (options) => {
					queried = options.logGroupNames;
					return { rows: [] };
				},
			});
			await provider.searchLogs({ stage: 'production' });
			assert.strictEqual(queried.length, 2);
		});

		it('scopes the query to a single discovered group', async () => {
			let queried: string[] = [];
			const provider = searchProvider({
				metadataFor: ['/aws/lambda/my-fn', '/aws/lambda/ghost-fn'],
				runner: async (options) => {
					queried = options.logGroupNames;
					return { rows: [] };
				},
			});
			const result = await provider.searchLogs({ stage: 'production', group: '/aws/lambda/ghost-fn' });
			assert.deepStrictEqual(queried, ['/aws/lambda/ghost-fn']);
			assert.strictEqual(result.searchSource, 'insights');
		});

		it('refuses group names that are not part of the stack', async () => {
			const provider = searchProvider({ runner: async () => ({ rows: [] }) });
			const result = await provider.searchLogs({ stage: 'production', group: '/aws/lambda/other-apps-fn' });
			assert.strictEqual(result.searchSource, 'unavailable');
			assert.match(result.searchError ?? '', /not part of/);
		});

		it('returns empty (not an error) for a discovered group that has no logs yet', async () => {
			const provider = searchProvider({
				runner: async () => {
					throw new Error('must not query');
				},
			});
			// ghost-fn is discovered but NOT in metadataFor (default: only my-fn).
			const result = await provider.searchLogs({ stage: 'production', group: '/aws/lambda/ghost-fn' });
			assert.strictEqual(result.searchSource, 'insights');
			assert.deepStrictEqual(result.queriedGroups, []);
			assert.deepStrictEqual(result.entries, []);
		});

		it('classifies a query timeout distinctly', async () => {
			const { InsightsTimeoutError } = await import('./log-search.js');
			const provider = searchProvider({
				runner: async () => {
					throw new InsightsTimeoutError(15000);
				},
			});
			const result = await provider.searchLogs({ stage: 'production' });
			assert.strictEqual(result.searchSource, 'unavailable');
			assert.strictEqual(result.searchErrorCode, 'QUERY_TIMEOUT');
		});

		it('propagates discovery failure as search unavailability', async () => {
			const root = makeProject({});
			const provider = new LocalDataProvider(root);
			const result = await provider.searchLogs({ stage: 'sandbox' });
			assert.strictEqual(result.searchSource, 'unavailable');
			assert.match(result.searchError ?? '', /stack name/i);
		});
	});

	describe('listResources & listEnvironments', () => {
		const files = {
			'.blocks/deploy-history.jsonl': JSON.stringify({
				id: 'd1',
				stage: 'production',
				startedAt: '2026-08-18T10:00:00Z',
				status: 'SUCCEEDED',
				stackName: 'my-app-prod',
				region: 'us-east-1',
			}),
			// Production's own outputs document is what now supplies its region.
			// The sandbox deliberately has none, so it exercises tier 4.
			'.blocks-sandbox/outputs.production.json': JSON.stringify({
				'my-app-prod': { ApiUrl: 'https://abc.execute-api.us-east-1.amazonaws.com/prod/' },
			}),
		};
		const stackResources = [
			{
				LogicalResourceId: 'UsersTable',
				PhysicalResourceId: 'users-tbl',
				ResourceType: 'AWS::DynamoDB::Table',
				ResourceStatus: 'CREATE_COMPLETE',
			},
		];
		const stackTemplate = {
			Resources: {
				UsersTable: { Metadata: { 'aws:cdk:path': 'my-app-prod/my-app/auth/users/table/Resource' } },
				Other: { Metadata: { 'aws:cdk:path': 'my-app-prod/my-app/todos/x/y/Resource' } },
			},
		};

		function fullProvider(opts: {
			describe?: (stackName: string, region?: string) => Promise<Record<string, unknown>>;
			template?: () => Promise<typeof stackTemplate>;
		}) {
			const root = makeProject(files);
			return new LocalDataProvider(
				root,
				async () => [],
				async () => stackResources,
				async () => new Map(),
				async () => ({ rows: [] }),
				async () => (opts.template ? opts.template() : stackTemplate),
				async (stackName, region) =>
					opts.describe
						? opts.describe(stackName, region)
						: {
								StackStatus: 'UPDATE_COMPLETE',
								LastUpdatedTime: new Date('2026-08-18T13:31:00Z'),
								DriftInformation: { StackDriftStatus: 'NOT_CHECKED' },
								Outputs: [{ OutputKey: 'ApiUrl', OutputValue: 'https://api.example.com' }],
							},
			);
		}

		it('groups resources by block using recorded stack target + template paths', async () => {
			const provider = fullProvider({});
			const result = await provider.listResources('production');
			assert.strictEqual(result.resourcesSource, 'cloudformation');
			assert.strictEqual(result.stackName, 'my-app-prod');
			assert.strictEqual(result.totalResources, 1);
			assert.deepStrictEqual(
				result.groups.map((g) => [g.id, g.category]),
				[['my-app/auth', 'app']],
			);
		});

		it('classifies resource listing failures', async () => {
			const provider = fullProvider({
				template: async () => {
					throw new Error('The security token included in the request is expired');
				},
			});
			const result = await provider.listResources('production');
			assert.strictEqual(result.resourcesSource, 'unavailable');
			assert.strictEqual(result.resourcesErrorCode, 'CREDENTIALS_EXPIRED');
		});

		it('lists environments: deployed with status/drift/outputs, not-deployed on missing stack', async () => {
			const provider = fullProvider({
				describe: async (stackName) => {
					if (stackName === 'my-app-prod') {
						return {
							StackStatus: 'UPDATE_COMPLETE',
							LastUpdatedTime: new Date('2026-08-18T13:31:00Z'),
							DriftInformation: {
								StackDriftStatus: 'IN_SYNC',
								LastCheckTimestamp: new Date('2026-08-17T09:00:00Z'),
							},
							Outputs: [{ OutputKey: 'ApiUrl', OutputValue: 'https://api.example.com' }],
						};
					}
					throw new Error(`Stack with id ${stackName} does not exist`);
				},
			});
			const result = await provider.listEnvironments();
			const prod = result.environments.find((e) => e.stage === 'production');
			const sandbox = result.environments.find((e) => e.stage === 'sandbox');
			assert.strictEqual(prod?.state, 'deployed');
			assert.strictEqual(prod.stackStatus, 'UPDATE_COMPLETE');
			assert.strictEqual(prod.driftStatus, 'IN_SYNC');
			assert.deepStrictEqual(prod.outputs, { ApiUrl: 'https://api.example.com' });
			assert.match(prod.consoleUrl ?? '', /us-east-1\.console/);
			assert.strictEqual(prod.regionSource, 'outputs');
			// The sandbox has no outputs document, no record and no config, so no
			// region resolves and there is nothing to look up — tier 4. It must say
			// so rather than render a bare "not deployed".
			assert.strictEqual(sandbox?.state, 'not-deployed');
			assert.strictEqual(sandbox.regionSource, 'none');
			assert.match(sandbox.stateReason ?? '', /npm run sandbox/);
		});

		it('names the region it looked in when the stack is genuinely absent there', async () => {
			const provider = fullProvider({
				describe: async (stackName) => {
					throw new Error(`Stack with id ${stackName} does not exist`);
				},
			});
			const prod = (await provider.listEnvironments()).environments.find((e) => e.stage === 'production');
			assert.strictEqual(prod?.state, 'not-deployed');
			// "nothing in us-east-1", never "nothing anywhere" — the distinction the
			// wrong-region defect collapsed.
			assert.match(prod.stateReason ?? '', /us-east-1/);
			assert.match(prod.stateReason ?? '', /outputs file/);
		});

		it('marks environments unknown on non-not-found errors', async () => {
			const provider = fullProvider({
				describe: async () => {
					throw new Error('The security token included in the request is expired');
				},
			});
			const result = await provider.listEnvironments();
			const prod = result.environments.find((e) => e.stage === 'production');
			assert.strictEqual(prod?.state, 'unknown');
			assert.match(prod.error ?? '', /expired/);
		});
	});

	describe('getCost', () => {
		const files = {
			'.blocks/deploy-history.jsonl': JSON.stringify({
				id: 'd1',
				stage: 'sandbox',
				startedAt: '2026-08-19T10:00:00Z',
				status: 'SUCCEEDED',
				stackName: 'my-stack',
				region: 'us-east-1',
			}),
		};

		function costProvider(opts: {
			tags?: () => Promise<Array<{ TagKey: string; Status: string }>>;
			costs?: (query: { attribution: string; filter?: unknown }) => Promise<unknown[]>;
		}) {
			const root = makeProject(files);
			return new LocalDataProvider(
				root,
				async () => [],
				async () => [],
				async () => new Map(),
				async () => ({ rows: [] }),
				async () => ({}),
				async () => ({}),
				async () => (opts.tags ? opts.tags() : []),
				async (query) => (opts.costs ? opts.costs(query) : []) as never,
			);
		}

		it('uses the stack tag when active and caches the result', async () => {
			let calls = 0;
			let attribution = '';
			const provider = costProvider({
				tags: async () => [{ TagKey: 'aws:cloudformation:stack-name', Status: 'Active' }],
				costs: async (query) => {
					calls++;
					attribution = query.attribution;
					return [
						{
							TimePeriod: { Start: '2026-08-18' },
							Groups: [
								{ Keys: ['AWS Lambda'], Metrics: { UnblendedCost: { Amount: '0.5', Unit: 'USD' } } },
							],
						},
					];
				},
			});
			const first = await provider.getCost('sandbox');
			const second = await provider.getCost('sandbox');
			assert.strictEqual(first.attribution, 'stack-tag');
			assert.strictEqual(attribution, 'stack-tag');
			assert.strictEqual(first.total, 0.5);
			assert.strictEqual(first.tags?.stackNameTagActive, true);
			assert.strictEqual(calls, 1, 'second call must come from cache — CE requests cost money');
			assert.strictEqual(second.fetchedAt, first.fetchedAt);
		});

		it('reports unattributed account totals when no tag is active', async () => {
			const provider = costProvider({ tags: async () => [] });
			const result = await provider.getCost('sandbox');
			assert.strictEqual(result.attribution, 'account-unattributed');
		});

		it('probes when tag listing is unavailable (linked account): stack filter first, account fallback on empty', async () => {
			const queries: string[] = [];
			const provider = costProvider({
				tags: async () => {
					throw new Error('Linked account does not have access to cost allocation tags');
				},
				costs: async (query) => {
					queries.push(query.attribution);
					if (query.attribution === 'stack-tag') return []; // tag inactive → empty
					return [
						{
							TimePeriod: { Start: '2026-08-18' },
							Total: { UnblendedCost: { Amount: '2.5', Unit: 'USD' } },
						},
					];
				},
			});
			const result = await provider.getCost('sandbox');
			assert.deepStrictEqual(queries, ['stack-tag', 'account-unattributed']);
			assert.strictEqual(result.costSource, 'cost-explorer');
			assert.strictEqual(result.attribution, 'account-unattributed');
			assert.strictEqual(result.total, 2.5);
			assert.strictEqual(result.tags, undefined);
		});

		it('classifies missing Cost Explorer permissions as ACCESS_DENIED and caches the error', async () => {
			let calls = 0;
			const provider = costProvider({
				tags: async () => [],
				costs: async () => {
					calls++;
					throw new Error('User is not authorized to perform: ce:GetCostAndUsage');
				},
			});
			const result = await provider.getCost('sandbox');
			await provider.getCost('sandbox');
			assert.strictEqual(result.costSource, 'unavailable');
			assert.strictEqual(result.costErrorCode, 'ACCESS_DENIED');
			assert.strictEqual(calls, 1, 'errors must be cached too');
		});
	});

	describe('getDeployment', () => {
		const failedRecord = JSON.stringify({
			id: 'f1',
			stage: 'production',
			startedAt: '2026-08-18T10:00:00Z',
			finishedAt: '2026-08-18T10:04:00Z',
			status: 'FAILED',
		});

		it('returns undefined for unknown ids', async () => {
			const root = makeProject({ '.blocks/deploy-history.jsonl': failedRecord });
			assert.strictEqual(await new LocalDataProvider(root).getDeployment('nope'), undefined);
		});

		it('skips event fetching for successful deployments', async () => {
			const line = JSON.stringify({
				id: 's1',
				stage: 'production',
				startedAt: '2026-08-18T10:00:00Z',
				status: 'SUCCEEDED',
			});
			const root = makeProject({ '.blocks/deploy-history.jsonl': line });
			const detail = await new LocalDataProvider(root, async () => {
				throw new Error('must not be called');
			}).getDeployment('s1');
			assert.strictEqual(detail?.eventsSource, 'not-applicable');
			assert.deepStrictEqual(detail.failureEvents, []);
		});

		it('fetches failure events and picks the root cause for a failed production deploy', async () => {
			const root = makeProject({
				'.blocks/deploy-history.jsonl': failedRecord,
				'.blocks/config.json': JSON.stringify({ stackId: 'my-app' }),
			});
			let requestedStack: string | undefined;
			const provider = new LocalDataProvider(root, async (stackName) => {
				requestedStack = stackName;
				return [
					{
						Timestamp: new Date('2026-08-18T10:02:00Z'),
						LogicalResourceId: 'Table',
						ResourceType: 'AWS::DynamoDB::Table',
						ResourceStatus: 'CREATE_FAILED',
						ResourceStatusReason: 'resource already exists',
					},
					{
						Timestamp: new Date('2026-08-18T10:03:00Z'),
						LogicalResourceId: 'Fn',
						ResourceType: 'AWS::Lambda::Function',
						ResourceStatus: 'CREATE_FAILED',
						ResourceStatusReason: 'Resource creation cancelled',
					},
				];
			});
			const detail = await provider.getDeployment('f1');
			assert.strictEqual(requestedStack, 'my-app-prod');
			assert.strictEqual(detail?.eventsSource, 'cloudformation');
			assert.strictEqual(detail.failureEvents.length, 2);
			assert.strictEqual(detail.rootCause?.logicalResourceId, 'Table');
		});

		it('resolves sandbox stack names from sandbox-id.txt', async () => {
			const record = JSON.stringify({
				id: 'f2',
				stage: 'sandbox',
				startedAt: '2026-08-18T10:00:00Z',
				status: 'FAILED',
			});
			const root = makeProject({
				'.blocks/deploy-history.jsonl': record,
				'.blocks/config.json': JSON.stringify({ stackId: 'my-app' }),
			});
			mkdirSync(join(root, '.blocks-sandbox'), { recursive: true });
			writeFileSync(join(root, '.blocks-sandbox', 'sandbox-id.txt'), 'my-abc123\n');
			let requestedStack: string | undefined;
			const provider = new LocalDataProvider(root, async (stackName) => {
				requestedStack = stackName;
				return [];
			});
			const detail = await provider.getDeployment('f2');
			assert.strictEqual(requestedStack, 'my-app-my-abc123');
			assert.strictEqual(detail?.eventsSource, 'cloudformation');
		});

		it('reports unavailable when the stack name cannot be resolved', async () => {
			const root = makeProject({ '.blocks/deploy-history.jsonl': failedRecord });
			const detail = await new LocalDataProvider(root).getDeployment('f1');
			assert.strictEqual(detail?.eventsSource, 'unavailable');
			assert.match(detail.eventsError ?? '', /stack name/i);
		});

		it('reports unavailable when the event fetch throws (e.g. no credentials)', async () => {
			const root = makeProject({
				'.blocks/deploy-history.jsonl': failedRecord,
				'.blocks/config.json': JSON.stringify({ stackId: 'my-app' }),
			});
			const provider = new LocalDataProvider(root, async () => {
				throw new Error('Could not load credentials');
			});
			const detail = await provider.getDeployment('f1');
			assert.strictEqual(detail?.eventsSource, 'unavailable');
			assert.match(detail.eventsError ?? '', /credentials/);
			assert.strictEqual(detail.eventsErrorCode, 'CREDENTIALS_MISSING');
		});

		it('classifies expired-token failures and reports the aws context', async () => {
			const root = makeProject({
				'.blocks/deploy-history.jsonl': failedRecord,
				'.blocks/config.json': JSON.stringify({ stackId: 'my-app' }),
			});
			const provider = new LocalDataProvider(root, async () => {
				throw new Error('The security token included in the request is expired');
			});
			const detail = await provider.getDeployment('f1');
			assert.strictEqual(detail?.eventsErrorCode, 'CREDENTIALS_EXPIRED');
			// No flag, no AWS_REGION and no outputs document: no tier supplied a
			// region, so the context says so instead of implying one was found.
			assert.strictEqual(detail.awsContext?.regionSource, 'none');
		});

		it("prefers the recorded stackName, and takes the region from the stage's outputs file", async () => {
			const record = JSON.stringify({
				id: 'f3',
				stage: 'production',
				startedAt: '2026-08-18T10:00:00Z',
				status: 'FAILED',
				stackName: 'recorded-stack-prod',
				// Ignored for region resolution; kept here to prove it is ignored.
				region: 'ap-southeast-2',
			});
			// .blocks/config.json deliberately points at a DIFFERENT stackId —
			// the recorded stack name must still win over the derived one.
			const root = makeProject({
				'.blocks/deploy-history.jsonl': record,
				'.blocks/config.json': JSON.stringify({ stackId: 'other-app' }),
				'.blocks-sandbox/outputs.production.json': JSON.stringify({
					'recorded-stack-prod': {
						ApiUrl: 'https://abc.execute-api.eu-central-1.amazonaws.com/prod/',
					},
				}),
			});
			let requested: { stackName?: string; region?: string } = {};
			const provider = new LocalDataProvider(root, async (stackName, region) => {
				requested = { stackName, region };
				return [];
			});
			const detail = await provider.getDeployment('f3');
			assert.deepStrictEqual(requested, { stackName: 'recorded-stack-prod', region: 'eu-central-1' });
			assert.strictEqual(detail?.awsContext?.region, 'eu-central-1');
			assert.strictEqual(detail.awsContext?.regionSource, 'outputs');
		});
	});

	describe('readData', () => {
		type Args = ConstructorParameters<typeof LocalDataProvider>;

		const deployed = {
			'.blocks/deploy-history.jsonl': JSON.stringify({
				id: 'd1',
				stage: 'production',
				startedAt: '2026-08-18T10:00:00Z',
				status: 'SUCCEEDED',
				stackName: 'my-app-prod',
				region: 'eu-central-1',
			}),
			// The region now comes from production's own outputs document.
			'.blocks-sandbox/outputs.production.json': JSON.stringify({
				'my-app-prod': { ApiUrl: 'https://abc.execute-api.eu-central-1.amazonaws.com/prod/' },
			}),
		};
		const stackResources = [
			{
				LogicalResourceId: 'TodosTable',
				PhysicalResourceId: 'todos-tbl',
				ResourceType: 'AWS::DynamoDB::Table',
				ResourceStatus: 'CREATE_COMPLETE',
			},
		];
		const stackTemplate = {
			Resources: {
				TodosTable: { Metadata: { 'aws:cdk:path': 'my-app-prod/my-app/todos/table/Resource' } },
			},
		};

		const todos = {
			type: 'DistributedTable',
			id: 'todos',
			fullId: 'my-app-todos',
			category: 'data' as const,
			file: 'src/foundation.ts',
			line: 12,
		};
		const discovered: ReturnType<NonNullable<Args[10]>> = {
			blocksSource: 'source-scan',
			projectName: 'my-app',
			blocks: [todos],
			unknownConstructs: [],
			scannedFiles: 1,
		};

		const localPage: ReturnType<NonNullable<Args[11]>> = {
			source: 'bb-data',
			stores: [{ id: 'todos', label: 'todos', kind: 'bb-data-file', ancillary: false }],
			activeStore: 'todos',
			keyFields: ['id'],
			records: [{ key: 'a1', value: { id: 'a1' }, redacted: false }],
			nextCursor: 'page-2',
			totalRecords: 1,
			totalRecordsExact: true,
			redacted: false,
		};
		const cloudPage: Awaited<ReturnType<NonNullable<Args[12]>>> = {
			source: 'dynamodb',
			stores: [{ id: 'todos-tbl', label: 'todos-tbl', kind: 'dynamodb', ancillary: false }],
			activeStore: 'todos-tbl',
			keyFields: ['pk', 'sk'],
			records: [{ key: 'a1', value: { pk: 'a1' }, redacted: true }],
			totalRecords: 1,
			totalRecordsExact: false,
			redacted: true,
		};

		/** Both readers default to throwing: an unexpected call fails loudly. */
		function dataProvider(opts: { root: string; local?: Args[11]; cloud?: Args[12] }) {
			return new LocalDataProvider(
				opts.root,
				async () => [],
				async () => stackResources,
				async () => new Map(),
				async () => ({ rows: [] }),
				async () => stackTemplate,
				async () => ({}),
				async () => [],
				async () => [],
				async () => ({}) as never,
				() => discovered,
				opts.local ??
					(() => {
						throw new Error('the local reader must not be called');
					}),
				opts.cloud ??
					(async () => {
						throw new Error('the cloud reader must not be called');
					}),
			);
		}

		it('local mode delegates to the local reader with projectRoot and paging arguments', async () => {
			const root = makeProject({});
			let received: Parameters<NonNullable<Args[11]>>[0] | undefined;
			const provider = dataProvider({
				root,
				local: (options) => {
					received = options;
					return localPage;
				},
			});
			const result = await provider.readData({
				stage: 'sandbox',
				mode: 'local',
				blockFullId: 'my-app-todos',
				store: 'todos',
				cursor: 'page-1',
				limit: 25,
			});
			assert.deepStrictEqual(received, {
				projectRoot: root,
				blockFullId: 'my-app-todos',
				store: 'todos',
				cursor: 'page-1',
				limit: 25,
			});
			assert.strictEqual(result.dataSource, 'bb-data');
			assert.strictEqual(result.activeStore, 'todos');
			assert.deepStrictEqual(result.keyFields, ['id']);
			assert.strictEqual(result.nextCursor, 'page-2');
			assert.strictEqual(result.records.length, 1);
			assert.strictEqual(result.dataErrorCode, undefined);
		});

		it("cloud mode passes the block and the stage's block-labelled resource groups", async () => {
			const root = makeProject(deployed);
			let received: Parameters<NonNullable<Args[12]>>[0] | undefined;
			const provider = dataProvider({
				root,
				cloud: async (options) => {
					received = options;
					return cloudPage;
				},
			});
			const result = await provider.readData({
				stage: 'production',
				mode: 'cloud',
				blockFullId: 'my-app-todos',
			});
			assert.strictEqual(received?.block.fullId, 'my-app-todos');
			// The same block-labelled groups the Resources view shows, not a
			// separately fetched template.
			assert.deepStrictEqual(
				received?.groups.map((g) => [g.id, g.blockFullId]),
				[['my-app/todos', 'my-app-todos']],
			);
			// Region comes from the deploy record, not the ambient environment.
			assert.strictEqual(received?.region, 'eu-central-1');
			assert.strictEqual(result.dataSource, 'dynamodb');
			assert.deepStrictEqual(result.keyFields, ['pk', 'sk']);
			assert.strictEqual(result.totalRecordsExact, false);
			assert.strictEqual(result.redacted, true);
		});

		it('refuses an unknown blockFullId with BLOCK_NOT_FOUND without invoking either reader', async () => {
			const root = makeProject(deployed);
			let localCalls = 0;
			let cloudCalls = 0;
			const provider = dataProvider({
				root,
				local: () => {
					localCalls++;
					return localPage;
				},
				cloud: async () => {
					cloudCalls++;
					return cloudPage;
				},
			});
			for (const mode of ['local', 'cloud'] as const) {
				const result = await provider.readData({ stage: 'production', mode, blockFullId: 'my-app' });
				assert.strictEqual(result.dataErrorCode, 'BLOCK_NOT_FOUND');
				assert.strictEqual(result.dataSource, 'unavailable');
				assert.deepStrictEqual(result.stores, []);
				assert.deepStrictEqual(result.records, []);
			}
			// The guard, not a nicety: 'my-app' is a prefix of the real block's
			// fullId, and both readers fall back to a sibling store. Reaching
			// either one would let a caller-supplied prefix resolve to a store
			// it never named.
			assert.strictEqual(localCalls, 0, 'the local reader must not see an unknown block id');
			assert.strictEqual(cloudCalls, 0, 'the cloud reader must not see an unknown block id');
		});

		it('reports an undeployed stage in cloud mode as unavailable, not an error', async () => {
			const root = makeProject({});
			const provider = dataProvider({ root });
			const result = await provider.readData({
				stage: 'sandbox',
				mode: 'cloud',
				blockFullId: 'my-app-todos',
			});
			assert.strictEqual(result.dataSource, 'unavailable');
			// An undeployed stage is a normal state, so no error code.
			assert.strictEqual(result.dataErrorCode, undefined);
			assert.match(result.dataError ?? '', /not deployed/i);
		});

		it('echoes stage, mode and blockFullId on the result', async () => {
			const local = await dataProvider({ root: makeProject({}), local: () => localPage }).readData({
				stage: 'sandbox',
				mode: 'local',
				blockFullId: 'my-app-todos',
			});
			assert.deepStrictEqual([local.stage, local.mode, local.blockFullId], ['sandbox', 'local', 'my-app-todos']);
			const cloud = await dataProvider({ root: makeProject(deployed), cloud: async () => cloudPage }).readData({
				stage: 'production',
				mode: 'cloud',
				blockFullId: 'my-app-todos',
			});
			assert.deepStrictEqual(
				[cloud.stage, cloud.mode, cloud.blockFullId],
				['production', 'cloud', 'my-app-todos'],
			);
		});

		it('reports awsContext for cloud and omits it for local', async () => {
			const local = await dataProvider({ root: makeProject({}), local: () => localPage }).readData({
				stage: 'sandbox',
				mode: 'local',
				blockFullId: 'my-app-todos',
			});
			assert.strictEqual(local.awsContext, undefined, 'the local path touches no AWS');
			const cloud = await dataProvider({ root: makeProject(deployed), cloud: async () => cloudPage }).readData({
				stage: 'production',
				mode: 'cloud',
				blockFullId: 'my-app-todos',
			});
			assert.strictEqual(cloud.awsContext?.region, 'eu-central-1');
			assert.strictEqual(cloud.awsContext?.regionSource, 'outputs');
		});
	});

	describe('writeRecord & deleteRecord', () => {
		type Args = ConstructorParameters<typeof LocalDataProvider>;
		type LocalPut = NonNullable<Args[13]>;
		type LocalDelete = NonNullable<Args[14]>;
		type CloudPut = NonNullable<Args[15]>;
		type CloudDelete = NonNullable<Args[16]>;

		const deployed = {
			'.blocks/deploy-history.jsonl': JSON.stringify({
				id: 'd1',
				stage: 'production',
				startedAt: '2026-08-18T10:00:00Z',
				status: 'SUCCEEDED',
				stackName: 'my-app-prod',
				region: 'eu-central-1',
			}),
			// The region now comes from production's own outputs document.
			'.blocks-sandbox/outputs.production.json': JSON.stringify({
				'my-app-prod': { ApiUrl: 'https://abc.execute-api.eu-central-1.amazonaws.com/prod/' },
			}),
		};
		const stackResources = [
			{
				LogicalResourceId: 'TodosTable',
				PhysicalResourceId: 'todos-tbl',
				ResourceType: 'AWS::DynamoDB::Table',
				ResourceStatus: 'CREATE_COMPLETE',
			},
		];
		const stackTemplate = {
			Resources: {
				TodosTable: { Metadata: { 'aws:cdk:path': 'my-app-prod/my-app/todos/table/Resource' } },
			},
		};

		/** Carries a keySchema: the local writer needs it to address a record. */
		const todos = {
			type: 'DistributedTable',
			id: 'todos',
			fullId: 'my-app-todos',
			category: 'data' as const,
			file: 'src/foundation.ts',
			line: 12,
			keySchema: { partitionKey: 'id' },
		};
		const discovered: ReturnType<NonNullable<Args[10]>> = {
			blocksSource: 'source-scan',
			projectName: 'my-app',
			blocks: [todos],
			unknownConstructs: [],
			scannedFiles: 1,
		};

		const written = { id: 'a1', title: 'buy milk' };

		/** Every writer defaults to throwing: an unexpected write fails loudly. */
		function writeProvider(opts: {
			root: string;
			localPut?: LocalPut;
			localDelete?: LocalDelete;
			cloudPut?: CloudPut;
			cloudDelete?: CloudDelete;
		}) {
			const refuse = (which: string) => () => {
				throw new Error(`the ${which} writer must not be called`);
			};
			return new LocalDataProvider(
				opts.root,
				async () => [],
				async () => stackResources,
				async () => new Map(),
				async () => ({ rows: [] }),
				async () => stackTemplate,
				async () => ({}),
				async () => [],
				async () => [],
				async () => ({}) as never,
				() => discovered,
				() => {
					throw new Error('the local reader must not be called');
				},
				async () => {
					throw new Error('the cloud reader must not be called');
				},
				opts.localPut ?? refuse('local put'),
				opts.localDelete ?? refuse('local delete'),
				opts.cloudPut ?? refuse('cloud put'),
				opts.cloudDelete ?? refuse('cloud delete'),
			);
		}

		it('local mode delegates to the local writer with projectRoot and the block key schema', async () => {
			const root = makeProject({});
			let received: Parameters<LocalPut> | undefined;
			const provider = writeProvider({
				root,
				localPut: async (...args) => {
					received = args;
					return { ok: true, message: 'Wrote 1 record.' };
				},
			});
			const result = await provider.writeRecord({
				stage: 'sandbox',
				mode: 'local',
				blockFullId: 'my-app-todos',
				store: 'todos',
				writeMode: 'create',
				item: written,
			});
			assert.deepStrictEqual(received?.[0], {
				projectRoot: root,
				blockFullId: 'my-app-todos',
				store: 'todos',
				// Without the schema the writer cannot name the fields inside a
				// serialized key, so it would append instead of replacing.
				keySchema: { partitionKey: 'id' },
			});
			assert.deepStrictEqual(received?.[1], written);
			assert.strictEqual(received?.[2], 'create');
			assert.deepStrictEqual(result, { ok: true, message: 'Wrote 1 record.' });
		});

		it('local delete delegates with the key values and the key schema', async () => {
			const root = makeProject({});
			let received: Parameters<LocalDelete> | undefined;
			const result = await writeProvider({
				root,
				localDelete: async (...args) => {
					received = args;
					return { ok: true, message: 'Deleted 1 record.' };
				},
			}).deleteRecord({
				stage: 'sandbox',
				mode: 'local',
				blockFullId: 'my-app-todos',
				keyValues: { id: 'a1' },
			});
			assert.strictEqual(received?.[0].projectRoot, root);
			assert.deepStrictEqual(received?.[0].keySchema, { partitionKey: 'id' });
			assert.strictEqual(received?.[0].store, undefined);
			assert.deepStrictEqual(received?.[1], { id: 'a1' });
			assert.strictEqual(result.ok, true);
		});

		it("cloud write receives the block and the stage's block-labelled resource groups", async () => {
			const root = makeProject(deployed);
			let received: Parameters<CloudPut> | undefined;
			const result = await writeProvider({
				root,
				cloudPut: async (...args) => {
					received = args;
					return { ok: true, message: 'Put 1 item.' };
				},
			}).writeRecord({
				stage: 'production',
				mode: 'cloud',
				blockFullId: 'my-app-todos',
				writeMode: 'edit',
				item: written,
			});
			assert.strictEqual(received?.[0].block.fullId, 'my-app-todos');
			// The same block-labelled groups the Resources view shows, so a block
			// cannot be writable here and missing there.
			assert.deepStrictEqual(
				received?.[0].groups.map((g) => [g.id, g.blockFullId]),
				[['my-app/todos', 'my-app-todos']],
			);
			// Region comes from the deploy record, not the ambient environment.
			assert.strictEqual(received?.[0].region, 'eu-central-1');
			assert.strictEqual(received?.[2], 'edit');
			assert.strictEqual(result.ok, true);
		});

		it('cloud delete receives the block, the groups and the key values', async () => {
			const root = makeProject(deployed);
			let received: Parameters<CloudDelete> | undefined;
			const result = await writeProvider({
				root,
				cloudDelete: async (...args) => {
					received = args;
					return { ok: true, message: 'Deleted 1 item.' };
				},
			}).deleteRecord({
				stage: 'production',
				mode: 'cloud',
				blockFullId: 'my-app-todos',
				keyValues: { pk: 'a1', sk: 'v0' },
			});
			assert.strictEqual(received?.[0].block.fullId, 'my-app-todos');
			assert.strictEqual(received?.[0].groups.length, 1);
			assert.deepStrictEqual(received?.[1], { pk: 'a1', sk: 'v0' });
			assert.strictEqual(result.ok, true);
		});

		it('refuses an unknown blockFullId without invoking any writer', async () => {
			const root = makeProject(deployed);
			let calls = 0;
			const count = async () => {
				calls++;
				return { ok: true, message: 'should not happen' };
			};
			const provider = writeProvider({
				root,
				localPut: count,
				localDelete: count,
				cloudPut: count,
				cloudDelete: count,
			});
			for (const mode of ['local', 'cloud'] as const) {
				const write = await provider.writeRecord({
					stage: 'production',
					mode,
					// A prefix of the real block's fullId: exactly the input the
					// writers' default-store fallback would otherwise resolve.
					blockFullId: 'my-app',
					writeMode: 'create',
					item: written,
				});
				assert.strictEqual(write.ok, false);
				assert.strictEqual(write.refusalCode, 'NOT_FOUND');
				assert.match(write.message, /no block with id/i);

				const remove = await provider.deleteRecord({
					stage: 'production',
					mode,
					blockFullId: 'my-app',
					keyValues: { id: 'a1' },
				});
				assert.strictEqual(remove.ok, false);
				assert.strictEqual(remove.refusalCode, 'NOT_FOUND');
			}
			// The guard, not a nicety: a mutation reaching a store the caller
			// never named is worse than a read doing so.
			assert.strictEqual(calls, 0, 'no writer may see an unknown block id');
		});

		it('refuses an undeployed stage in cloud mode with a clear message', async () => {
			const provider = writeProvider({ root: makeProject({}) });
			const write = await provider.writeRecord({
				stage: 'sandbox',
				mode: 'cloud',
				blockFullId: 'my-app-todos',
				writeMode: 'create',
				item: written,
			});
			assert.strictEqual(write.ok, false);
			assert.match(write.message, /not deployed/i);
			// An undeployed stage is a normal state, so no refusal *code* — the UI
			// must not render "you have not deployed yet" as a policy rejection.
			assert.strictEqual(write.refusalCode, undefined);
			const remove = await provider.deleteRecord({
				stage: 'sandbox',
				mode: 'cloud',
				blockFullId: 'my-app-todos',
				keyValues: { id: 'a1' },
			});
			assert.strictEqual(remove.ok, false);
			assert.match(remove.message, /not deployed/i);
		});

		it('maps a refusal from either writer onto WriteResult, keeping both codes', async () => {
			const local = await writeProvider({
				root: makeProject({}),
				localPut: async () => ({
					ok: false,
					message: 'The dev server is running and would clobber this edit.',
					refusalCode: 'LOCAL_SERVER_RUNNING' as const,
				}),
			}).writeRecord({
				stage: 'sandbox',
				mode: 'local',
				blockFullId: 'my-app-todos',
				writeMode: 'create',
				item: written,
			});
			assert.deepStrictEqual(local, {
				ok: false,
				message: 'The dev server is running and would clobber this edit.',
				refusalCode: 'LOCAL_SERVER_RUNNING',
			});

			const cloud = await writeProvider({
				root: makeProject(deployed),
				cloudPut: async () => ({
					ok: false,
					message: 'The table for that block is not in the production stack.',
					errorCode: 'STORE_NOT_FOUND' as const,
				}),
			}).writeRecord({
				stage: 'production',
				mode: 'cloud',
				blockFullId: 'my-app-todos',
				writeMode: 'create',
				item: written,
			});
			// The classified cause is forwarded, not dropped. Originally this asserted
			// the opposite, on the grounds that `message` carried the detail — but a
			// message is not machine-readable, so an IAM denial and a dropped table
			// arrived at the browser indistinguishable from each other in cloud mode
			// while the local path reported both precisely.
			assert.deepStrictEqual(cloud, {
				ok: false,
				message: 'The table for that block is not in the production stack.',
				errorCode: 'STORE_NOT_FOUND',
			});
		});

		it('forwards a writer refusal code the contract union does not list, rather than relabelling it', async () => {
			const result = await writeProvider({
				root: makeProject({}),
				localDelete: async () => ({
					ok: false,
					message: 'That store is a kind this dashboard cannot write.',
					refusalCode: 'UNSUPPORTED_STORE' as const,
				}),
			}).deleteRecord({
				stage: 'sandbox',
				mode: 'local',
				blockFullId: 'my-app-todos',
				keyValues: { id: 'a1' },
			});
			// Verbatim: folding this into NOT_FOUND would claim the record is
			// missing when the truth is that the store cannot be written at all.
			assert.strictEqual(result.refusalCode, 'UNSUPPORTED_STORE');
		});

		it('omits refusalCode entirely on a successful write rather than sending undefined', async () => {
			const result = await writeProvider({
				root: makeProject({}),
				localPut: async () => ({ ok: true, message: 'Wrote 1 record.' }),
			}).writeRecord({
				stage: 'sandbox',
				mode: 'local',
				blockFullId: 'my-app-todos',
				writeMode: 'edit',
				item: written,
			});
			assert.deepStrictEqual(Object.keys(result).sort(), ['message', 'ok']);
		});
	});

	describe('listRpcMethods & invokeRpc', () => {
		type Args = ConstructorParameters<typeof LocalDataProvider>;
		type BuildCatalogue = NonNullable<Args[17]>;
		type ResolveEndpoint = NonNullable<Args[18]>;
		type Invoke = NonNullable<Args[19]>;

		const todos = {
			type: 'ApiNamespace',
			id: 'todos-api',
			fullId: 'my-app-todos-api',
			category: 'core' as const,
			file: 'src/api.ts',
			line: 7,
		};
		const discovered: ReturnType<NonNullable<Args[10]>> = {
			blocksSource: 'source-scan',
			projectName: 'my-app',
			blocks: [todos],
			unknownConstructs: [],
			scannedFiles: 1,
		};
		const catalogue: Awaited<ReturnType<BuildCatalogue>> = {
			methodsSource: 'spec',
			namespaces: [
				{
					namespace: 'todos-api',
					blockFullId: 'my-app-todos-api',
					methods: [{ name: 'list', origin: 'source+spec', params: [{ name: 'limit', type: 'number' }] }],
				},
			],
		};

		/** Every RPC seam defaults to throwing: an unexpected call fails loudly. */
		function rpcProvider(opts: {
			root: string;
			blocks?: Args[10];
			catalogue?: BuildCatalogue;
			resolve?: ResolveEndpoint;
			invoke?: Invoke;
		}) {
			return new LocalDataProvider(
				opts.root,
				async () => [],
				async () => [],
				async () => new Map(),
				async () => ({ rows: [] }),
				async () => ({}),
				async () => ({}),
				async () => [],
				async () => [],
				async () => ({}) as never,
				opts.blocks ?? (() => discovered),
				() => {
					throw new Error('the local reader must not be called');
				},
				async () => {
					throw new Error('the cloud reader must not be called');
				},
				async () => {
					throw new Error('the local put must not be called');
				},
				async () => {
					throw new Error('the local delete must not be called');
				},
				async () => {
					throw new Error('the cloud put must not be called');
				},
				async () => {
					throw new Error('the cloud delete must not be called');
				},
				opts.catalogue ??
					(async () => {
						throw new Error('the catalogue builder must not be called');
					}),
				opts.resolve ??
					(async () => {
						throw new Error('the endpoint resolver must not be called');
					}),
				opts.invoke ??
					(async () => {
						throw new Error('the invoker must not be called');
					}),
			);
		}

		const ok: Awaited<ReturnType<Invoke>> = {
			endpoint: 'https://api.example.test/rpc',
			ok: true,
			httpStatus: 200,
			durationMs: 12,
			body: { jsonrpc: '2.0', id: 1, result: [] },
		};

		it('builds the catalogue from the cached block list rather than re-scanning the source', async () => {
			const root = makeProject({});
			let scans = 0;
			let received: Parameters<BuildCatalogue> | undefined;
			const provider = rpcProvider({
				root,
				blocks: () => {
					scans += 1;
					return discovered;
				},
				catalogue: async (...args) => {
					received = args;
					return catalogue;
				},
			});

			const result = await provider.listRpcMethods();
			assert.deepStrictEqual(result, catalogue);
			// The blocks the catalogue is built from are the discovered ones,
			// handed over with the project root.
			assert.strictEqual(received?.[0], root);
			assert.deepStrictEqual(received?.[1], [todos]);

			// Second call: served from the provider's own block cache, so opening
			// the playground twice does not re-parse the app's source.
			await provider.listRpcMethods();
			assert.strictEqual(scans, 1);
		});

		it('resolves the endpoint, then invokes it with the method and positional params', async () => {
			let resolved: Parameters<ResolveEndpoint> | undefined;
			let invoked: Parameters<Invoke> | undefined;
			const result = await rpcProvider({
				root: makeProject({}),
				resolve: async (...args) => {
					resolved = args;
					return { ok: true, endpoint: 'https://api.example.test/rpc', source: 'stack-output' };
				},
				invoke: async (...args) => {
					invoked = args;
					return ok;
				},
			}).invokeRpc({ stage: 'production', mode: 'cloud', method: 'todos-api.list', params: [10, 'open'] });

			assert.strictEqual(resolved?.[0]?.stage, 'production');
			assert.strictEqual(resolved?.[0]?.mode, 'cloud');
			assert.strictEqual(invoked?.[0]?.endpoint, 'https://api.example.test/rpc');
			assert.strictEqual(invoked?.[0]?.method, 'todos-api.list');
			// Positional and untouched: order is the app's contract, not ours.
			assert.deepStrictEqual(invoked?.[0]?.params, [10, 'open']);
			assert.strictEqual(result.ok, true);
			assert.strictEqual(result.httpStatus, 200);
			assert.deepStrictEqual(result.body, { jsonrpc: '2.0', id: 1, result: [] });
		});

		it('maps a NO_ENDPOINT resolution to a result rather than throwing, and never invokes', async () => {
			const result = await rpcProvider({
				root: makeProject({}),
				resolve: async () => ({
					ok: false,
					code: 'NO_ENDPOINT',
					message: 'Stage "production" is not deployed, so it has no RPC endpoint yet.',
				}),
				// invoke left at its throwing default: there is nothing to call.
			}).invokeRpc({ stage: 'production', mode: 'cloud', method: 'todos-api.list', params: [] });

			assert.strictEqual(result.transportErrorCode, 'NO_ENDPOINT');
			assert.strictEqual(result.ok, false);
			assert.strictEqual(result.httpStatus, 0);
			// Empty rather than a guess: no endpoint was called, so naming one
			// would claim a request that never happened.
			assert.strictEqual(result.endpoint, '');
			assert.strictEqual(result.body, 'Stage "production" is not deployed, so it has no RPC endpoint yet.');
		});

		it('echoes stage and mode back on the success path', async () => {
			const result = await rpcProvider({
				root: makeProject({}),
				resolve: async () => ({ ok: true, endpoint: 'http://127.0.0.1:3000/rpc', source: 'local-dev-server' }),
				invoke: async () => ok,
			}).invokeRpc({ stage: 'sandbox', mode: 'local', method: 'todos-api.list', params: [] });

			assert.strictEqual(result.stage, 'sandbox');
			assert.strictEqual(result.mode, 'local');
		});

		it('echoes stage and mode back on the failure path too', async () => {
			// The environment a failed call was aimed at is the whole question a
			// user asks of a failure, so it must survive the failure path.
			const result = await rpcProvider({
				root: makeProject({}),
				resolve: async () => ({ ok: false, code: 'NO_ENDPOINT', message: 'no endpoint' }),
			}).invokeRpc({ stage: 'production', mode: 'cloud', method: 'todos-api.list', params: [] });

			assert.strictEqual(result.stage, 'production');
			assert.strictEqual(result.mode, 'cloud');
		});

		it('reports an upstream 401 as a result, not as a rejection', async () => {
			const result = await rpcProvider({
				root: makeProject({}),
				resolve: async () => ({ ok: true, endpoint: 'https://api.example.test/rpc', source: 'sandbox-config' }),
				invoke: async () => ({
					endpoint: 'https://api.example.test/rpc',
					ok: false,
					httpStatus: 401,
					durationMs: 8,
					body: { message: 'Unauthorized' },
				}),
			}).invokeRpc({ stage: 'sandbox', mode: 'cloud', method: 'todos-api.list', params: [] });

			// The app's own auth rejecting the call is an outcome to render, and
			// the provider passes it through with the environment attached.
			assert.strictEqual(result.httpStatus, 401);
			assert.strictEqual(result.ok, false);
			assert.strictEqual(result.stage, 'sandbox');
			assert.strictEqual(result.mode, 'cloud');
		});
	});
});
