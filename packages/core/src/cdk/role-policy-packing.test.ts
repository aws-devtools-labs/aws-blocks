// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cxapi from 'aws-cdk-lib/cx-api';
import { Construct } from 'constructs';
import type { ScopeParent } from '../common/index.js';
import { BlocksPresets } from './blocks-defaults.js';
import { ComputeBase } from './compute/compute.js';
import type { DefaultComputeFactory } from './compute/default-compute-factory.js';
import { BlocksStack } from './index.js';
import {
	enableRolePolicyPacking,
	MANAGED_POLICIES_PER_ROLE_QUOTA_CONTEXT_KEY,
	MERGE_EXECUTION_ROLE_POLICIES_CONTEXT_KEY,
} from './role-policy-packing.js';

// IAM's documented limits the packed output must stay under.
const INLINE_LIMIT = 10_240;
const MANAGED_LIMIT = 6_144;

type Statement = {
	Effect: string;
	Action?: string | string[];
	NotAction?: string | string[];
	Resource?: unknown;
	NotResource?: unknown;
	Condition?: unknown;
};
type PolicyResource = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: unknown[] } };

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** A long literal ARN, so sizes are exact rather than CDK's token estimate. */
const arn = (i: number) => `arn:aws:s3:::blocks-packing-test-bucket-${i}-${'x'.repeat(80)}/*`;

/** `n` statements that can't be merged with each other: distinct actions AND distinct resources. */
function addDistinct(role: iam.IRole, n: number, offset = 0) {
	for (let i = offset; i < offset + n; i++) {
		role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: [`s3:GetObjectV${i}`], resources: [arn(i)] }));
	}
}

/** `n` statements that share their actions, so CDK's merging can combine them. */
const SHARED_ACTIONS = ['s3:GetObject', 's3:GetObjectVersion', 's3:GetObjectTagging', 's3:GetObjectAcl'];
function addCombinable(role: iam.IRole, n: number) {
	for (let i = 0; i < n; i++) {
		role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: SHARED_ACTIONS, resources: [arn(i)] }));
	}
}

const MERGE_ON = { [MERGE_EXECUTION_ROLE_POLICIES_CONTEXT_KEY]: true };

function makeRole(options: { packing: boolean; context?: Record<string, unknown> }) {
	const app = new cdk.App({ context: options.context });
	const stack = new cdk.Stack(app, 'PackingStack');
	const role = new iam.Role(stack, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
	if (options.packing) enableRolePolicyPacking(role);
	return { app, stack, role };
}

/** The DefaultPolicy and every managed policy attached to the role, from the synthesized template. */
function policiesOf(template: Template) {
	const inline = Object.values(template.findResources('AWS::IAM::Policy') as Record<string, PolicyResource>);
	const managed = Object.entries(template.findResources('AWS::IAM::ManagedPolicy') as Record<string, PolicyResource>);
	return { inline, managed };
}

/**
 * Every (effect, action, resource, condition) tuple the role is granted, across
 * all of its policies. `NotAction` / `NotResource` entries are kept distinct.
 */
function grantedTuples(template: Template): Set<string> {
	const { inline, managed } = policiesOf(template);
	const tuples = new Set<string>();
	for (const p of [...inline, ...managed.map(([, m]) => m)]) {
		for (const s of p.Properties.PolicyDocument.Statement) {
			const actions = [...asArray(s.Action), ...asArray(s.NotAction).map((a) => `not:${a}`)];
			const resources = [...asArray(s.Resource), ...asArray(s.NotResource).map((r) => ({ not: r }))];
			const condition = JSON.stringify(s.Condition ?? {});
			for (const a of actions) {
				for (const r of resources) tuples.add(JSON.stringify([s.Effect, a, r, condition]));
			}
		}
	}
	return tuples;
}

const hasOverflow = (template: Template) =>
	Object.keys(template.findResources('AWS::IAM::ManagedPolicy')).some((id) => id.includes('OverflowPolicy'));

const statementCount = (template: Template) => {
	const { inline, managed } = policiesOf(template);
	return [...inline, ...managed.map(([, m]) => m)].reduce(
		(n, p) => n + p.Properties.PolicyDocument.Statement.length,
		0,
	);
};

const mergeNotAppliedInfo = (stack: cdk.Stack) =>
	Annotations.fromStack(stack).findInfo('*', Match.stringLikeRegexp("PolicyDocument's 'minimize' field"));

describe('enableRolePolicyPacking — merging off (context key unset or false)', () => {
	test('within budget: same template as without packing, statements not merged', () => {
		const build = (packing: boolean) => {
			const { stack, role } = makeRole({ packing });
			// Combinable statements: if merging ran, they would be merged.
			addCombinable(role, 20);
			return Template.fromStack(stack);
		};
		const withPacking = build(true);
		assert.deepStrictEqual(withPacking.toJSON(), build(false).toJSON());
		withPacking.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
		assert.strictEqual(statementCount(withPacking), 20);
	});

	for (const context of [undefined, { [MERGE_EXECUTION_ROLE_POLICIES_CONTEXT_KEY]: false }]) {
		test(`an overflowing role synthesizes byte-identically to plain CDK (${context ? 'false' : 'unset'})`, () => {
			const build = (packing: boolean) => {
				const { stack, role } = makeRole({ packing, context });
				addCombinable(role, 150);
				addDistinct(role, 40);
				return JSON.stringify(Template.fromStack(stack).toJSON());
			};
			const packed = build(true);
			assert.ok(packed.includes('OverflowPolicy'), 'the role overflows');
			assert.strictEqual(packed, build(false));
		});
	}
});

describe('enableRolePolicyPacking — merge context key', () => {
	const build = (value: unknown) => {
		const { stack, role } = makeRole({
			packing: true,
			context: value === undefined ? undefined : { [MERGE_EXECUTION_ROLE_POLICIES_CONTEXT_KEY]: value },
		});
		addCombinable(role, 20);
		return () => Template.fromStack(stack);
	};

	for (const value of [true, 'true']) {
		test(`${JSON.stringify(value)} merges`, () => {
			assert.ok(statementCount(build(value)()) < 20, 'statements were merged');
		});
	}

	for (const value of [false, 'false', undefined]) {
		test(`${value === undefined ? 'unset' : JSON.stringify(value)} does not merge`, () => {
			assert.strictEqual(statementCount(build(value)()), 20);
		});
	}

	for (const value of ['yes', 1, '']) {
		test(`${JSON.stringify(value)} fails synth`, () => {
			assert.throws(build(value), /mergeExecutionRolePolicies" must be true or false/);
		});
	}
});

describe('enableRolePolicyPacking — merging on', () => {
	test('merges with the installed aws-cdk-lib, even within the inline budget', () => {
		// Guards the `minimize` coupling: a CDK that keeps the field but ignores it fails here.
		const { stack, role } = makeRole({ packing: true, context: MERGE_ON });
		addCombinable(role, 20);
		const template = Template.fromStack(stack);
		assert.strictEqual(statementCount(template), 1, 'the 20 statements share their actions');
		assert.ok(!hasOverflow(template));
		assert.deepStrictEqual(mergeNotAppliedInfo(stack), []);
	});

	test('synthesizes with the overflow packed into managed policies attached to the role', () => {
		const { stack, role } = makeRole({ packing: true, context: MERGE_ON });
		const n = 120;
		addDistinct(role, n);
		const template = Template.fromStack(stack);

		const { inline, managed } = policiesOf(template);
		assert.ok(managed.length >= 1, 'expected OverflowPolicy managed policies');
		const roleRef = { Ref: stack.resolve((role.node.defaultChild as iam.CfnRole).logicalId) };
		for (const [id, m] of managed) {
			assert.ok(id.includes('OverflowPolicy'), `unexpected managed policy ${id}`);
			assert.deepStrictEqual(m.Properties.Roles, [roleRef]);
			const size = JSON.stringify(m.Properties.PolicyDocument).length;
			assert.ok(size <= MANAGED_LIMIT, `${id} is ${size} chars, over ${MANAGED_LIMIT}`);
		}
		assert.strictEqual(inline.length, 1);
		const inlineSize = JSON.stringify(inline[0].Properties.PolicyDocument).length;
		assert.ok(inlineSize <= INLINE_LIMIT, `DefaultPolicy is ${inlineSize} chars, over ${INLINE_LIMIT}`);

		const expected = new Set(
			Array.from({ length: n }, (_, i) => JSON.stringify(['Allow', `s3:GetObjectV${i}`, arn(i), '{}'])),
		);
		assert.deepStrictEqual(grantedTuples(template), expected, 'every granted permission is preserved');
	});

	test('merges combinable statements first, so fewer managed policies are needed', () => {
		const build = (merge: boolean) => {
			const { stack, role } = makeRole({ packing: true, context: merge ? MERGE_ON : undefined });
			addCombinable(role, 150);
			return Template.fromStack(stack);
		};
		const merged = build(true);
		const unmerged = build(false);

		const mergedCount = policiesOf(merged).managed.length;
		const unmergedCount = policiesOf(unmerged).managed.length;
		assert.ok(mergedCount < unmergedCount, `expected fewer managed policies: ${mergedCount} vs ${unmergedCount}`);
		assert.ok(statementCount(merged) < 150, 'statements were merged');
		assert.deepStrictEqual(grantedTuples(merged), grantedTuples(unmerged), 'merging preserves every permission');
		for (const [id, m] of policiesOf(merged).managed) {
			const size = JSON.stringify(m.Properties.PolicyDocument).length;
			assert.ok(size <= MANAGED_LIMIT, `${id} is ${size} chars, over ${MANAGED_LIMIT}`);
		}
	});

	test('merges with the aspect-priorities and aspect-stabilization flags on', () => {
		const flags = { [cxapi.ASPECT_PRIORITIES_MUTATING]: true, '@aws-cdk/core:aspectStabilization': true };
		const build = (merge: boolean) => {
			const { stack, role } = makeRole({ packing: true, context: { ...flags, ...(merge ? MERGE_ON : {}) } });
			addCombinable(role, 150);
			return Template.fromStack(stack);
		};
		const merged = build(true);
		const unmerged = build(false);
		const mergedCount = policiesOf(merged).managed.length;
		const unmergedCount = policiesOf(unmerged).managed.length;
		assert.ok(mergedCount < unmergedCount, `expected fewer managed policies: ${mergedCount} vs ${unmergedCount}`);
		assert.deepStrictEqual(grantedTuples(merged), grantedTuples(unmerged), 'merging preserves every permission');
	});

	test('preserves every (effect, action, resource, condition) tuple for grants that must not be combined', () => {
		const build = (merge: boolean) => {
			const { stack, role } = makeRole({ packing: true, context: merge ? MERGE_ON : undefined });
			const add = (props: iam.PolicyStatementProps) => role.addToPrincipalPolicy(new iam.PolicyStatement(props));
			for (let i = 0; i < 20; i++) {
				const b1 = `arn:aws:s3:::hostile-a-${i}/*`;
				const b2 = `arn:aws:s3:::hostile-b-${i}/*`;
				// Cross-product trap: merging both lists would grant Get on b2 and Put on b1.
				add({ actions: ['s3:GetObject'], resources: [b1] });
				add({ actions: ['s3:PutObject'], resources: [b2] });
				// Same action, different conditions.
				add({
					actions: ['s3:DeleteObject'],
					resources: [b1],
					conditions: { StringEquals: { 'aws:PrincipalTag/team': `t${i}` } },
				});
				add({ actions: ['s3:DeleteObject'], resources: [b2] });
				// Deny next to Allow on the same action and resource.
				add({ effect: iam.Effect.DENY, actions: ['s3:GetObject'], resources: [b2] });
				// `*` next to specific ARNs.
				add({ actions: ['s3:ListAllMyBuckets'], resources: ['*'] });
				add({ actions: ['s3:ListAllMyBuckets'], resources: [b1] });
				// Statements with a Sid are never merged.
				add({ sid: `Sid${i}`, actions: ['s3:GetObject'], resources: [b2] });
				// NotAction / NotResource.
				add({ notActions: ['s3:DeleteBucket'], resources: [b1] });
				add({ actions: ['s3:GetObjectAcl'], notResources: [b2] });
				// Exact duplicates.
				add({ actions: ['s3:GetObjectTagging'], resources: [b1] });
				add({ actions: ['s3:GetObjectTagging'], resources: [b1] });
			}
			// Padding that merges, so the role overflows and merging has an effect.
			addCombinable(role, 150);
			return Template.fromStack(stack);
		};
		const merged = build(true);
		const unmerged = build(false);
		assert.ok(hasOverflow(unmerged), 'the unmerged role overflows');
		assert.ok(
			policiesOf(merged).managed.length < policiesOf(unmerged).managed.length,
			'merging reduced the overflow policy count',
		);
		assert.deepStrictEqual(grantedTuples(merged), grantedTuples(unmerged));
	});

	test('merges and packs a grant added by an inherited aspect at CDK’s split priority', () => {
		const build = (merge: boolean) => {
			const { stack, role } = makeRole({ packing: true, context: merge ? MERGE_ON : undefined });
			addCombinable(role, 150);
			let added = false;
			cdk.Aspects.of(stack).add(
				{
					visit(node) {
						if (node !== role || added) return;
						added = true;
						for (let i = 0; i < 40; i++) {
							role.addToPrincipalPolicy(
								new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [`${arn(i)}-late`] }),
							);
						}
					},
				},
				{ priority: cdk.AspectPriority.DEFAULT },
			);
			return Template.fromStack(stack);
		};
		const merged = build(true);
		const late = [...policiesOf(merged).inline, ...policiesOf(merged).managed.map(([, m]) => m)]
			.flatMap((p) => p.Properties.PolicyDocument.Statement)
			.filter((s) => asArray(s.Action).includes('s3:PutObject'));
		assert.strictEqual(late.length, 1, 'the 40 late statements were merged into one');
		for (const p of policiesOf(merged).inline) {
			const size = JSON.stringify(p.Properties.PolicyDocument).length;
			assert.ok(size <= INLINE_LIMIT, `DefaultPolicy is ${size} chars, over ${INLINE_LIMIT}`);
		}
		assert.deepStrictEqual(grantedTuples(merged), grantedTuples(build(false)));
	});

	test('skips merging with an info annotation when CDK no longer exposes the minimize field', () => {
		const { stack, role } = makeRole({ packing: true, context: MERGE_ON });
		addCombinable(role, 150);
		const document = (role.node.findChild('DefaultPolicy') as iam.Policy).document;
		// Simulate an aws-cdk-lib version without the field merging sets.
		delete (document as unknown as { minimize?: boolean }).minimize;

		const template = Template.fromStack(stack);
		assert.strictEqual(statementCount(template), 150, 'nothing merged');
		assert.ok(hasOverflow(template), 'CDK still packs the unmerged statements');
		Annotations.fromStack(stack).hasInfo(
			'/PackingStack/Role',
			Match.stringLikeRegexp("doesn't allow merging .*the field is missing or read-only"),
		);
	});

	test('skips merging with an info annotation when the minimize field is read-only', () => {
		const { stack, role } = makeRole({ packing: true, context: MERGE_ON });
		addCombinable(role, 150);
		const document = (role.node.findChild('DefaultPolicy') as iam.Policy).document;
		Object.defineProperty(document, 'minimize', { value: undefined, writable: false });

		const template = Template.fromStack(stack);
		assert.strictEqual(statementCount(template), 150, 'nothing merged');
		assert.strictEqual(mergeNotAppliedInfo(stack).length, 1);
	});
});

/** A stand-in for a Building Block: a construct with a `fullId`, owning `buckets` buckets granted to `role`. */
class FakeBlock extends Construct {
	readonly fullId: string;
	constructor(scope: Construct, id: string, role: iam.IRole, buckets: number) {
		super(scope, id);
		this.fullId = `fake-${id.toLowerCase()}`;
		for (let i = 0; i < buckets; i++) {
			const bucket = new s3.Bucket(this, `Bucket${i}`);
			role.addToPrincipalPolicy(
				new iam.PolicyStatement({
					actions: [`s3:GetObjectV${id}${i}`],
					resources: [bucket.arnForObjects('*')],
				}),
			);
		}
	}
}

describe('enableRolePolicyPacking — managed-policies-per-role quota', () => {
	// ~78,000 estimated characters: 10,000 stay inline, the rest needs 11+ managed policies.
	const MANY = 400;

	test('fails synth with an actionable error when the role needs more managed policies than allowed', () => {
		const { stack, role } = makeRole({ packing: true });
		addDistinct(role, MANY);
		assert.throws(
			() => Template.fromStack(stack),
			(err: Error) => {
				assert.match(err.message, /PackingStack\/Role needs \d+ managed policies, more than the 10 allowed/);
				assert.match(err.message, /separate Blocks backend \(another BlocksStack or BlocksBackend\)/);
				assert.ok(err.message.includes(MANAGED_POLICIES_PER_ROLE_QUOTA_CONTEXT_KEY), err.message);
				assert.doesNotMatch(err.message, /blocks-iam\.json/);
				// Merging wasn't requested, so the message doesn't claim it ran.
				assert.match(err.message, /even after packing them into managed policies/);
				assert.doesNotMatch(err.message, /merging/);
				return true;
			},
		);
	});

	test('mentions merging only when it was applied', () => {
		const { stack, role } = makeRole({ packing: true, context: MERGE_ON });
		addDistinct(role, MANY);
		assert.throws(() => Template.fromStack(stack), /even after merging statements and packing them/);

		const fallback = makeRole({ packing: true, context: MERGE_ON });
		addDistinct(fallback.role, MANY);
		const document = (fallback.role.node.findChild('DefaultPolicy') as iam.Policy).document;
		delete (document as unknown as { minimize?: boolean }).minimize;
		assert.throws(
			() => Template.fromStack(fallback.stack),
			(err: Error) => {
				assert.doesNotMatch(err.message, /merging/);
				return true;
			},
		);
	});

	test('names the Building Blocks granting the most, largest first', () => {
		const { stack, role } = makeRole({ packing: true });
		new FakeBlock(stack, 'Small', role, 2);
		new FakeBlock(stack, 'Large', role, 40);
		new FakeBlock(stack, 'Medium', role, 10);
		addDistinct(role, MANY);
		assert.throws(
			() => Template.fromStack(stack),
			(err: Error) => {
				assert.match(
					err.message,
					/granting the most \(approximate characters of policy statements\): fake-large \(PackingStack\/Large\): ~\d+; fake-medium \(PackingStack\/Medium\): ~\d+; fake-small \(PackingStack\/Small\): ~\d+\./,
				);
				return true;
			},
		);
	});

	test('passes with exactly the quota of managed policies, fails one above it', () => {
		const build = (awsManaged: number) => {
			const { stack, role } = makeRole({ packing: true });
			for (let i = 0; i < awsManaged; i++) {
				role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(`Policy${i}`));
			}
			addDistinct(role, 120);
			return () => Template.fromStack(stack);
		};
		const overflow = policiesOf(build(0)()).managed.length;
		assert.doesNotThrow(build(10 - overflow));
		assert.throws(build(11 - overflow), /needs 11 managed policies, more than the 10 allowed/);
	});

	for (const raised of [20, '20']) {
		test(`passes once the quota context is raised to ${JSON.stringify(raised)}`, () => {
			const { stack, role } = makeRole({
				packing: true,
				context: { [MANAGED_POLICIES_PER_ROLE_QUOTA_CONTEXT_KEY]: raised },
			});
			addDistinct(role, MANY);
			const managed = policiesOf(Template.fromStack(stack)).managed.length;
			assert.ok(managed > 10 && managed <= 20, `expected 11-20 managed policies, got ${managed}`);
		});
	}

	test('rejects a quota above IAM’s maximum of 20', () => {
		const { stack, role } = makeRole({
			packing: true,
			context: { [MANAGED_POLICIES_PER_ROLE_QUOTA_CONTEXT_KEY]: 25 },
		});
		addDistinct(role, 1);
		assert.throws(() => Template.fromStack(stack), /must be a whole number from 1 to 20/);
	});

	test('counts managed policies attached through ManagedPolicyArns alongside the overflow policies', () => {
		const { stack, role } = makeRole({ packing: true });
		for (let i = 0; i < 10; i++) role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(`Policy${i}`));
		// Overflows into at least one OverflowPolicy, which alone would be within the quota.
		addDistinct(role, 120);
		assert.throws(() => Template.fromStack(stack), /needs \d+ managed policies, more than the 10 allowed/);
	});

	test('does not check a role without overflow policies, even with 11 attached AWS-managed policies', () => {
		const { stack, role } = makeRole({ packing: true });
		for (let i = 0; i < 11; i++) role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(`Policy${i}`));
		addDistinct(role, 5);
		const template = Template.fromStack(stack);
		assert.strictEqual(
			Object.keys(template.findResources('AWS::IAM::ManagedPolicy')).length,
			0,
			'no overflow policies were created',
		);
	});

	test('enabling twice adds the quota check once', () => {
		const { stack, role } = makeRole({ packing: true });
		enableRolePolicyPacking(role);
		addDistinct(role, MANY);
		assert.throws(
			() => Template.fromStack(stack),
			(err: Error) => {
				assert.strictEqual(err.message.match(/needs \d+ managed policies/g)?.length, 1, err.message);
				return true;
			},
		);
	});
});

// ── Wiring into the shared execution role ─────────────────────────────────

// Same inline default-compute stub as permissions-boundary.test.ts: core's tests
// can't depend on @aws-blocks/bb-lambda-compute.
class StubLambdaCompute extends ComputeBase {
	readonly fn: lambda.NodejsFunction;

	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope });
		this.fn = new lambda.NodejsFunction(this, 'Handler', {
			entry: this.backendHandlerPath,
			runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
			handler: 'handler',
			role: this.executionRole,
			environment: { BLOCKS_STACK_NAME: this.backendStackName },
			bundling: { minify: true, esbuildArgs: { '--conditions': 'aws-runtime' } },
		});
	}

	setEnv(key: string, value: string): void {
		this.fn.addEnvironment(key, value);
	}

	override apiHandler(): IFunction {
		return this.fn;
	}

	protected applyTracing(): void {}
	protected healthWidgets(_region: string): IWidget[][] {
		return [];
	}
	protected loggingWidgets(_region: string): IWidget[][] {
		return [];
	}
	protected tracingWidgets(_region: string): IWidget[][] {
		return [];
	}
}

const stubComputeFactory: DefaultComputeFactory = (root) => new StubLambdaCompute(root as never, 'DefaultCompute');

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('shared execution role (BlocksRole)', () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	const makeStack = async (app: cdk.App, id: string) =>
		BlocksStack.create(app, id, {
			backendHandlerPath: join(__dirname, '__fixtures__', 'handler.js'),
			backendCDKPath: join(__dirname, '__fixtures__', 'iam-boundary-backend.js'),
			defaults: BlocksPresets.sandbox,
			defaultComputeFactory: stubComputeFactory,
		});

	test('overflowing grants are packed and still listed in the IAM report', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-role-packing-'));
		dirs.push(dir);
		const app = new cdk.App({ outdir: dir });
		const stack = await makeStack(app, 'PackedRoleStack');
		addDistinct(stack.executionRole, 120);
		app.synth();

		const template = Template.fromStack(stack);
		const managed = Object.keys(template.findResources('AWS::IAM::ManagedPolicy'));
		const overflow = managed.filter((id) => id.startsWith('BlocksRoleOverflowPolicy'));
		assert.ok(overflow.length >= 1, `expected BlocksRole overflow policies, got ${managed}`);

		const report = JSON.parse(readFileSync(join(dir, `${stack.artifactId}.blocks-iam.json`), 'utf8')) as {
			executionRole: { statements: { actions?: string[]; policy: string }[] };
		};
		const reported = report.executionRole.statements.filter((s) =>
			s.actions?.some((a) => a.startsWith('s3:GetObjectV')),
		);
		assert.strictEqual(reported.length, 120, 'every packed statement is in the report');
		assert.ok(
			reported.some((s) => overflow.includes(s.policy)),
			'some statements are reported against an OverflowPolicy',
		);
	});

	test('the quota error names the shared role', async () => {
		const app = new cdk.App();
		const stack = await makeStack(app, 'OverQuotaStack');
		addDistinct(stack.executionRole, 400);
		assert.throws(
			() => app.synth(),
			(err: Error) => {
				assert.match(err.message, /OverQuotaStack\/BlocksRole needs \d+ managed policies/);
				assert.doesNotMatch(err.message, /blocks-iam\.json/);
				return true;
			},
		);
	});
});
