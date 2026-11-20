// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * On-demand revalidation → CloudFront invalidation wiring
 * (`cache.cdnInvalidation`): the server gets the distribution id through an
 * SSM parameter and `cloudfront:CreateInvalidation` on that one distribution.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { App, type CfnElement, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CDN_INVALIDATION_BASE_PATH_ENV, CDN_INVALIDATION_PARAM_ENV } from '../adapters/shared/cdn_invalidation_env.js';
import type { CacheConfig, DeployManifest } from '../manifest/types.js';
import { HostingConstruct, type HostingConstructProps } from './hosting_construct.js';

const API_URL = 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/cdk-blocks/api';

type Resource = { Type: string; Properties?: Record<string, unknown>; DependsOn?: string[] };
type Statement = { Action: string | string[]; Resource: unknown; Effect: string };

describe('HostingConstruct — CloudFront invalidation on on-demand revalidation', () => {
	let tmpDir: string;
	let bundleDir: string;
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-cdn-inval-'));
		fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
		bundleDir = path.join(tmpDir, 'server');
		fs.mkdirSync(bundleDir);
		fs.writeFileSync(path.join(bundleDir, 'index.mjs'), 'export const handler = async () => ({});');
	});
	afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	const manifest = (cache: Partial<CacheConfig> = {}, extra: Partial<DeployManifest> = {}): DeployManifest => ({
		version: 1,
		buildId: 'isr1',
		compute: {
			default: {
				type: 'handler',
				bundle: bundleDir,
				handler: 'index.handler',
				placement: 'regional',
				streaming: true,
				runtime: 'nodejs24.x',
			},
		},
		staticAssets: { directory: tmpDir },
		routes: [
			{ pattern: '/_next/static/*', target: 'static' },
			{ pattern: '/*', target: 'default' },
		],
		cache: {
			computeResource: 'default',
			tagRevalidation: true,
			revalidationQueue: true,
			cdnInvalidation: true,
			...cache,
		},
		...extra,
	});

	const synth = (m: DeployManifest, props: Partial<HostingConstructProps> = {}) => {
		const stack = new Stack(new App({ context: { sandboxMode: 'true' } }), 'App', {
			env: { account: '111111111111', region: 'us-west-2' },
		});
		const hosting = new HostingConstruct(stack, 'Hosting', { manifest: m, skipRegionValidation: true, ...props });
		return { template: Template.fromStack(stack), hosting };
	};

	const template = (m: DeployManifest): Record<string, Resource> =>
		synth(m).template.toJSON().Resources as Record<string, Resource>;

	const resources = (template: Template, type: string): Array<[string, Resource]> =>
		Object.entries(template.toJSON().Resources as Record<string, Resource>).filter(([, r]) => r.Type === type);

	// The deploy-time `/*` invalidation's custom resource has its own grant; only
	// count the policies attached to the server's role.
	const serverRoleId = (template: Template): string | undefined => {
		const roleOf = (r: Resource, key: string) =>
			(r.Properties?.[key] as { 'Fn::GetAtt'?: [string, string] } | undefined)?.['Fn::GetAtt']?.[0];
		const lambda = resources(template, 'AWS::Lambda::Function').find(
			([, r]) =>
				(r.Properties?.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables
					?.CACHE_BUCKET_NAME !== undefined,
		);
		return lambda ? roleOf(lambda[1], 'Role') : undefined;
	};

	const invalidationStatements = (template: Template): Statement[] =>
		resources(template, 'AWS::IAM::Policy')
			.filter(([, r]) =>
				(r.Properties?.Roles as Array<{ Ref?: string }> | undefined)?.some(
					(role) => role.Ref === serverRoleId(template),
				),
			)
			.flatMap(([, r]) =>
				((r.Properties?.PolicyDocument as { Statement?: Statement[] } | undefined)?.Statement ?? []).filter(
					(s) => [s.Action].flat().includes('cloudfront:CreateInvalidation'),
				),
			);

	const serverEnv = (template: Template): Record<string, unknown> => {
		const server = resources(template, 'AWS::Lambda::Function').find(([, r]) => {
			const vars = (r.Properties?.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables;
			return vars?.CACHE_BUCKET_NAME !== undefined;
		});
		assert.ok(server, 'the server function');
		return (
			(server[1].Properties?.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {}
		);
	};

	/** The serialized properties of the first resource of `type` (env vars of a Web Function revision). */
	const serverEnvOf = (template: Template, type: string): string =>
		JSON.stringify(resources(template, type)[0]?.[1].Properties);

	it('grants the server CreateInvalidation on its own distribution only', () => {
		const { template } = synth(manifest());
		const [distributionId] = resources(template, 'AWS::CloudFront::Distribution').map(([id]) => id);
		assert.ok(distributionId, 'a distribution');
		const statements = invalidationStatements(template);
		assert.equal(statements.length, 1, 'one invalidation grant');
		assert.equal(statements[0].Effect, 'Allow');
		// The ARN names this distribution (never `distribution/*`).
		assert.deepEqual(statements[0].Resource, {
			'Fn::Join': [
				'',
				['arn:', { Ref: 'AWS::Partition' }, ':cloudfront::111111111111:distribution/', { Ref: distributionId }],
			],
		});
	});

	it('hands the server the distribution id through an SSM parameter it alone can read', () => {
		const { template } = synth(manifest());
		const [distributionId] = resources(template, 'AWS::CloudFront::Distribution').map(([id]) => id);
		const params = resources(template, 'AWS::SSM::Parameter');
		assert.equal(params.length, 1);
		const [paramId, param] = params[0];
		assert.deepEqual(param.Properties?.Value, { Ref: distributionId });
		const name = param.Properties?.Name;
		assert.equal(typeof name, 'string');
		assert.match(name as string, /^\/cdk-blocks\/hosting\/App\/[0-9a-f]+\/distribution-id$/);

		// The server's environment carries the NAME (a plain string), not a
		// reference to the distribution, so there is no dependency cycle.
		assert.equal(serverEnv(template)[CDN_INVALIDATION_PARAM_ENV], name);
		assert.equal(serverEnv(template)[CDN_INVALIDATION_BASE_PATH_ENV], undefined);

		template.hasResourceProperties('AWS::IAM::Policy', {
			PolicyDocument: {
				Statement: Match.arrayWith([
					Match.objectLike({
						Action: 'ssm:GetParameter',
						Resource: Match.objectLike({
							'Fn::Join': Match.arrayWith([Match.arrayWith([{ Ref: paramId }])]),
						}),
					}),
				]),
			},
		});
	});

	// The server function → API → distribution chain must not loop back: the
	// server's environment carries only the parameter NAME, and the grant is a
	// standalone policy the function doesn't depend on.
	it('adds no dependency cycle (CloudFormation would reject the template)', () => {
		for (const m of [manifest(), manifest({}, { basePath: '/docs' })]) {
			const resourcesById = template(m);
			const deps = (value: unknown, out: Set<string>): Set<string> => {
				if (Array.isArray(value)) for (const v of value) deps(v, out);
				else if (value && typeof value === 'object') {
					for (const [k, v] of Object.entries(value)) {
						if (k === 'Ref' && typeof v === 'string' && v in resourcesById) out.add(v);
						else if (k === 'Fn::GetAtt' && Array.isArray(v) && typeof v[0] === 'string') out.add(v[0]);
						else deps(v, out);
					}
				}
				return out;
			};
			const graph = new Map<string, Set<string>>();
			for (const [id, r] of Object.entries(resourcesById)) {
				graph.set(id, deps(r.Properties, new Set(r.DependsOn ?? [])));
			}
			const state = new Map<string, 'visiting' | 'done'>();
			const visit = (id: string, trail: string[]): void => {
				if (state.get(id) === 'done') return;
				assert.notEqual(state.get(id), 'visiting', `dependency cycle: ${[...trail, id].join(' -> ')}`);
				state.set(id, 'visiting');
				for (const next of graph.get(id) ?? []) visit(next, [...trail, id]);
				state.set(id, 'done');
			};
			for (const id of graph.keys()) visit(id, []);
		}
	});

	it('passes the basePath to the server', () => {
		const { template } = synth(manifest({}, { basePath: '/docs' }));
		assert.equal(serverEnv(template)[CDN_INVALIDATION_BASE_PATH_ENV], '/docs');
	});

	it('wires a Web Function server too', () => {
		const m = manifest();
		m.compute = {
			default: {
				type: 'http-server',
				bundle: bundleDir,
				entrypoint: 'index.mjs',
				port: 3000,
				placement: 'regional',
			},
		};
		const { hosting, template } = synth(m, { compute: { type: 'web-function' } });
		const server = hosting.computeWebFunctions.get('default');
		assert.ok(server, 'the Web Function server');
		const roleId = Stack.of(server).getLogicalId(server.role.node.defaultChild as CfnElement);
		const policies = resources(template, 'AWS::IAM::Policy').filter(([, r]) =>
			JSON.stringify(r.Properties?.PolicyDocument).includes('cloudfront:CreateInvalidation'),
		);
		const serverPolicies = policies.filter(([, r]) =>
			((r.Properties?.Roles as Array<{ Ref?: string }> | undefined) ?? []).some((role) => role.Ref === roleId),
		);
		assert.equal(serverPolicies.length, 1, 'the invalidation policy is attached to the Web Function role');
		assert.ok(serverEnvOf(template, 'AWS::Lambda::WebFunctionRevision').includes(CDN_INVALIDATION_PARAM_ENV));
	});

	it('adds nothing when the server does not invalidate (no cache.cdnInvalidation)', () => {
		const { template } = synth(manifest({ cdnInvalidation: undefined }));
		assert.equal(invalidationStatements(template).length, 0);
		assert.equal(resources(template, 'AWS::SSM::Parameter').length, 0);
		assert.equal(serverEnv(template)[CDN_INVALIDATION_PARAM_ENV], undefined);
	});

	it('adds nothing behind a door without a CloudFront distribution', () => {
		const m = manifest();
		m.compute.default = { ...m.compute.default, streaming: false } as DeployManifest['compute'][string];
		const { template } = synth(m, { frontDoor: { kind: 'apiGateway' }, backendApi: { url: API_URL } });
		assert.equal(invalidationStatements(template).length, 0);
		assert.equal(serverEnv(template)[CDN_INVALIDATION_PARAM_ENV], undefined);
	});
});
