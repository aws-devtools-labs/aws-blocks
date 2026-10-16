// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { DiscoveredBlock } from '../contract/v1.js';
import { groupResources, inferAppScope, resolveAppScope, templateCdkPaths } from './resources.js';

const STACK = 'my-app-stack-prod';

function template(paths: Record<string, string>) {
	return {
		Resources: Object.fromEntries(
			Object.entries(paths).map(([id, path]) => [id, { Metadata: { 'aws:cdk:path': `${STACK}/${path}` } }]),
		),
	};
}

describe('templateCdkPaths', () => {
	it('extracts paths with the stack segment stripped', () => {
		const paths = templateCdkPaths(template({ Fn1: 'Handler/Resource' }));
		assert.strictEqual(paths.get('Fn1'), 'Handler/Resource');
	});

	it('skips resources without path metadata', () => {
		const paths = templateCdkPaths({ Resources: { X: {}, Y: { Metadata: {} } } });
		assert.strictEqual(paths.size, 0);
	});
});

describe('inferAppScope', () => {
	it('finds the single deep non-platform top-level construct', () => {
		const paths = templateCdkPaths(
			template({
				A: 'my-app/auth/users/table/Resource',
				B: 'my-app/todos/table/Resource',
				C: 'KitGsiProvider/framework-onEvent/ServiceRole/Resource',
				D: 'Handler/Resource',
				E: 'API/Resource',
			}),
		);
		assert.strictEqual(inferAppScope(paths), 'my-app');
	});

	it('returns undefined when ambiguous or absent', () => {
		assert.strictEqual(inferAppScope(templateCdkPaths(template({ D: 'Handler/Resource' }))), undefined);
		const ambiguous = templateCdkPaths(template({ A: 'app-one/x/y/z/Resource', B: 'app-two/x/y/z/Resource' }));
		assert.strictEqual(inferAppScope(ambiguous), undefined);
	});
});

describe('resolveAppScope', () => {
	// The shape of a real production stack: the app nests three deep and so does
	// Hosting, so inferAppScope ties and gives up. This is the case that left
	// every block group unattributed and the data view calling deployed blocks
	// absent.
	const productionPaths = templateCdkPaths(
		template({
			A: 'rota/auth/users/table/Resource',
			B: 'rota/absences/gsi-resource/Default',
			C: 'Hosting/Hosting/AssetDeploymentHtml/AwsCliLayer/Resource',
			D: 'BlocksGsiProvider/framework-onEvent/ServiceRole/Resource',
		}),
	);

	it('prefers the scope discovery named over the ambiguous guess', () => {
		assert.strictEqual(inferAppScope(productionPaths), undefined);
		assert.strictEqual(resolveAppScope(productionPaths, 'rota'), 'rota');
	});

	it('falls back to the guess when discovery supplied no scope', () => {
		const sandboxPaths = templateCdkPaths(template({ A: 'rota/auth/users/table/Resource' }));
		assert.strictEqual(resolveAppScope(sandboxPaths, undefined), 'rota');
		assert.strictEqual(resolveAppScope(productionPaths, undefined), undefined);
	});

	it('falls back when the named scope is not in this stack', () => {
		// Discovery reads today's source; the stack may predate a scope rename.
		// Trusting the name blindly would group every block under a construct the
		// template does not contain, i.e. nothing.
		assert.strictEqual(resolveAppScope(productionPaths, 'renamed-since-deploy'), undefined);
	});

	it('does not accept a childless top-level construct as the scope', () => {
		const paths = templateCdkPaths(template({ A: 'rota', B: 'Handler/Resource' }));
		assert.strictEqual(resolveAppScope(paths, 'rota'), undefined);
	});
});

describe('groupResources', () => {
	const cdkPaths = templateCdkPaths(
		template({
			UsersTable: 'my-app/auth/users/table/Resource',
			TodosTable: 'my-app/todos/table/Resource',
			HandlerFn: 'Handler/Resource',
			HandlerRole: 'Handler/ServiceRole/Resource',
			Api: 'API/Resource',
			Deployer: 'Custom::CDKBucketDeployment8693BB/ServiceRole/Resource',
			Meta: 'CDKMetadata/Default',
		}),
	);

	const raw = (id: string, type: string, status = 'CREATE_COMPLETE') => ({
		LogicalResourceId: id,
		PhysicalResourceId: `phys-${id}`,
		ResourceType: type,
		ResourceStatus: status,
	});

	const block = (type: string, id: string, fullId = `my-app-${id}`): DiscoveredBlock => ({
		type,
		id,
		fullId,
		category: 'data',
		file: 'aws-blocks/backend.ts',
		line: 12,
	});

	it('attributes a block only once the scope is resolved, not guessed', () => {
		// The production regression, end to end: with Hosting present the guess
		// returns undefined, the block's resources land in a 'platform' group and
		// no group carries a blockFullId — which is what made the data view report
		// a deployed block as absent.
		const paths = templateCdkPaths(
			template({
				UsersTable: 'my-app/auth/users/table/Resource',
				Cdn: 'Hosting/Hosting/AssetDeploymentHtml/AwsCliLayer/Resource',
			}),
		);
		const resources = [raw('UsersTable', 'AWS::DynamoDB::Table')];
		const blocks = [block('AuthBasic', 'auth')];

		const [guessed] = groupResources(resources, paths, { appScope: inferAppScope(paths), blocks });
		assert.strictEqual(guessed.id, 'my-app');
		assert.strictEqual(guessed.category, 'platform');
		assert.strictEqual(guessed.blockFullId, undefined);

		const [resolved] = groupResources(resources, paths, { appScope: resolveAppScope(paths, 'my-app'), blocks });
		assert.strictEqual(resolved.id, 'my-app/auth');
		assert.strictEqual(resolved.category, 'app');
		assert.strictEqual(resolved.blockFullId, 'my-app-auth');
	});

	it('groups app blocks by block path, platform by construct, cdk internals together', () => {
		const groups = groupResources(
			[
				raw('UsersTable', 'AWS::DynamoDB::Table'),
				raw('TodosTable', 'AWS::DynamoDB::Table'),
				raw('HandlerFn', 'AWS::Lambda::Function'),
				raw('HandlerRole', 'AWS::IAM::Role'),
				raw('Api', 'AWS::ApiGateway::RestApi'),
				raw('Deployer', 'AWS::IAM::Role'),
				raw('Meta', 'AWS::CDK::Metadata'),
			],
			cdkPaths,
			{ appScope: 'my-app' },
		);
		assert.deepStrictEqual(
			groups.map((g) => [g.id, g.category, g.resources.length]),
			[
				['my-app/auth', 'app', 1],
				['my-app/todos', 'app', 1],
				['API', 'platform', 1],
				['Handler', 'platform', 2],
				['CDK internals', 'cdk', 2],
			],
		);
	});

	it('keeps resource details including status and cdk path', () => {
		const [group] = groupResources([raw('UsersTable', 'AWS::DynamoDB::Table', 'UPDATE_FAILED')], cdkPaths, {
			appScope: 'my-app',
		});
		const { typeLabel, ...identity } = group.resources[0];
		assert.deepStrictEqual(identity, {
			logicalResourceId: 'UsersTable',
			resourceType: 'AWS::DynamoDB::Table',
			physicalResourceId: 'phys-UsersTable',
			resourceStatus: 'UPDATE_FAILED',
			cdkPath: 'my-app/auth/users/table/Resource',
		});
		// typeLabel comes from console-links' friendlyType; its exact wording is
		// that module's business, so only require a non-empty label here.
		assert.ok(typeLabel && typeLabel.length > 0);
	});

	it('handles resources missing from the template (no cdk path)', () => {
		const groups = groupResources([raw('Mystery', 'AWS::S3::Bucket')], cdkPaths);
		assert.strictEqual(groups[0].id, '(no construct path)');
		assert.strictEqual(groups[0].category, 'platform');
	});

	it('without an app scope everything non-cdk is platform', () => {
		const groups = groupResources([raw('UsersTable', 'AWS::DynamoDB::Table')], cdkPaths, { appScope: undefined });
		assert.strictEqual(groups[0].id, 'my-app');
		assert.strictEqual(groups[0].category, 'platform');
	});

	it('adds a console link when the region is known', () => {
		const [group] = groupResources([raw('UsersTable', 'AWS::DynamoDB::Table')], cdkPaths, {
			appScope: 'my-app',
			stackName: STACK,
			region: 'eu-west-1',
		});
		const resource = group.resources[0];
		assert.ok(resource.consoleUrl, 'expected a console url for a DynamoDB table');
		assert.strictEqual(typeof resource.directLink, 'boolean');
	});

	it('emits no console link at all when the region is unknown', () => {
		const [group] = groupResources([raw('UsersTable', 'AWS::DynamoDB::Table')], cdkPaths, {
			appScope: 'my-app',
			stackName: STACK,
		});
		// A link to the wrong region shows an empty console page, which reads as
		// "deleted". No link is the honest answer.
		assert.strictEqual(group.resources[0].consoleUrl, undefined);
		assert.strictEqual(group.resources[0].directLink, undefined);
	});

	it('labels a deployed group with the block that matches its construct path', () => {
		const groups = groupResources(
			[raw('UsersTable', 'AWS::DynamoDB::Table'), raw('TodosTable', 'AWS::DynamoDB::Table')],
			cdkPaths,
			{ appScope: 'my-app', blocks: [block('AuthNamespace', 'Auth'), block('DistributedTable', 'todos')] },
		);
		const auth = groups.find((g) => g.id === 'my-app/auth');
		const todos = groups.find((g) => g.id === 'my-app/todos');
		// Match is case-insensitive: 'Auth' in source, 'auth' in the cdk path.
		assert.strictEqual(auth?.blockFullId, 'my-app-Auth');
		assert.strictEqual(auth.blockType, 'AuthNamespace');
		assert.strictEqual(todos?.blockType, 'DistributedTable');
	});

	it('matches on fullId as well as id', () => {
		const [group] = groupResources([raw('UsersTable', 'AWS::DynamoDB::Table')], cdkPaths, {
			appScope: 'my-app',
			blocks: [block('AuthNamespace', 'identity', 'auth')],
		});
		assert.strictEqual(group.blockFullId, 'auth');
	});

	it('leaves both block fields undefined for a group no block matches', () => {
		const [group] = groupResources([raw('UsersTable', 'AWS::DynamoDB::Table')], cdkPaths, {
			appScope: 'my-app',
			blocks: [block('DistributedTable', 'somethingElse')],
		});
		assert.strictEqual(group.blockFullId, undefined);
		assert.strictEqual(group.blockType, undefined);
	});

	it('never creates a group from a declared-but-not-deployed block', () => {
		// The attribution rule. `hosting` is declared in source — e.g. inside
		// `if (!sandboxMode) new Hosting(scope, 'hosting', …)` — but this stage's
		// deployed template contains no Hosting resources. Source discovery may
		// only label groups the template produced, so no group appears for it.
		const groups = groupResources([raw('UsersTable', 'AWS::DynamoDB::Table')], cdkPaths, {
			appScope: 'my-app',
			blocks: [block('AuthNamespace', 'auth'), block('Hosting', 'hosting')],
		});
		assert.deepStrictEqual(
			groups.map((g) => g.id),
			['my-app/auth'],
		);
		assert.ok(!groups.some((g) => g.blockType === 'Hosting'));
	});

	it('does not let a block claim a platform construct group', () => {
		// An `api` block must not be attributed the Blocks-owned `API` construct:
		// blocks are children of the app scope, so only app groups can be theirs.
		const groups = groupResources([raw('Api', 'AWS::ApiGateway::RestApi')], cdkPaths, {
			appScope: 'my-app',
			blocks: [block('ApiNamespace', 'api')],
		});
		assert.strictEqual(groups[0].id, 'API');
		assert.strictEqual(groups[0].blockFullId, undefined);
	});
});
