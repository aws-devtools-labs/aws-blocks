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
import type { ScopeParent } from '../common/index.js';
import { BlocksPresets } from './blocks-defaults.js';
import { ComputeBase } from './compute/compute.js';
import type { DefaultComputeFactory } from './compute/default-compute-factory.js';
import { BlocksStack } from './index.js';
import {
	enableRolePolicyPacking,
	MANAGED_POLICIES_PER_ROLE_QUOTA_CONTEXT_KEY,
	ROLE_POLICY_PACKING_DRIFT_WARNING_ID,
} from './role-policy-packing.js';

// IAM's documented limits the packed output must stay under.
const INLINE_LIMIT = 10_240;
const MANAGED_LIMIT = 6_144;

type Statement = { Effect: string; Action: string | string[]; Resource: string | string[] };
type PolicyResource = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: unknown[] } };

const asArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

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

/** Every (action, resource) pair the role is granted, across all of its policies. */
function grantedPairs(template: Template): Set<string> {
	const { inline, managed } = policiesOf(template);
	const pairs = new Set<string>();
	for (const p of [...inline, ...managed.map(([, m]) => m)]) {
		for (const s of p.Properties.PolicyDocument.Statement) {
			for (const a of asArray(s.Action)) for (const r of asArray(s.Resource)) pairs.add(`${a} ${r}`);
		}
	}
	return pairs;
}

/** Drift warnings the packing added anywhere in the stack. */
const driftWarnings = (stack: cdk.Stack) =>
	Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp(ROLE_POLICY_PACKING_DRIFT_WARNING_ID));

const hasOverflow = (template: Template) =>
	Object.keys(template.findResources('AWS::IAM::ManagedPolicy')).some((id) => id.includes('OverflowPolicy'));

const statementCount = (template: Template) => {
	const { inline, managed } = policiesOf(template);
	return [...inline, ...managed.map(([, m]) => m)].reduce(
		(n, p) => n + p.Properties.PolicyDocument.Statement.length,
		0,
	);
};

describe('enableRolePolicyPacking — within the inline budget', () => {
	test('changes nothing: same template as without packing, statements not merged', () => {
		const build = (packing: boolean) => {
			const { stack, role } = makeRole({ packing });
			// Combinable statements: if consolidation ran, they would be merged.
			addCombinable(role, 20);
			return Template.fromStack(stack);
		};
		const withPacking = build(true);
		assert.deepStrictEqual(withPacking.toJSON(), build(false).toJSON());
		withPacking.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
		assert.strictEqual(statementCount(withPacking), 20);
	});
});

describe('enableRolePolicyPacking — over the inline budget', () => {
	test('synthesizes with the overflow packed into managed policies attached to the role', () => {
		const { stack, role } = makeRole({ packing: true });
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

		const expected = new Set(Array.from({ length: n }, (_, i) => `s3:GetObjectV${i} ${arn(i)}`));
		assert.deepStrictEqual(grantedPairs(template), expected, 'every granted permission is preserved');
	});

	test('merges combinable statements first, so fewer managed policies are needed', () => {
		const build = (packing: boolean) => {
			const { stack, role } = makeRole({ packing });
			addCombinable(role, 150);
			return Template.fromStack(stack);
		};
		const packed = build(true);
		const unpacked = build(false);

		const packedCount = policiesOf(packed).managed.length;
		const unpackedCount = policiesOf(unpacked).managed.length;
		assert.ok(
			packedCount < unpackedCount,
			`expected fewer managed policies with consolidation: ${packedCount} vs ${unpackedCount}`,
		);
		assert.ok(statementCount(packed) < 150, 'statements were merged');
		assert.deepStrictEqual(grantedPairs(packed), grantedPairs(unpacked), 'merging preserves every permission');
		for (const [id, m] of policiesOf(packed).managed) {
			const size = JSON.stringify(m.Properties.PolicyDocument).length;
			assert.ok(size <= MANAGED_LIMIT, `${id} is ${size} chars, over ${MANAGED_LIMIT}`);
		}
	});

	test('merges with the aspect-priorities and aspect-stabilization flags on', () => {
		const context = { [cxapi.ASPECT_PRIORITIES_MUTATING]: true, '@aws-cdk/core:aspectStabilization': true };
		const build = (packing: boolean) => {
			const { stack, role } = makeRole({ packing, context });
			addCombinable(role, 150);
			return Template.fromStack(stack);
		};
		const packed = build(true);
		const unpacked = build(false);
		const packedCount = policiesOf(packed).managed.length;
		const unpackedCount = policiesOf(unpacked).managed.length;
		assert.ok(
			packedCount < unpackedCount,
			`expected fewer managed policies with consolidation: ${packedCount} vs ${unpackedCount}`,
		);
		assert.deepStrictEqual(grantedPairs(packed), grantedPairs(unpacked), 'merging preserves every permission');
	});

	/**
	 * Build packed and unpacked roles with `n` combinable statements for every `n`
	 * in a range that straddles CDK's split threshold, and assert the packed
	 * template is byte-identical whenever CDK leaves the unpacked policy inline, and
	 * that no drift warning appears for any `n`.
	 */
	function assertUnchangedAroundThreshold(
		addStatements: (stack: cdk.Stack, role: iam.Role, n: number) => void,
		range: [number, number],
	) {
		const build = (packing: boolean, n: number) => {
			const { stack, role } = makeRole({ packing });
			addStatements(stack, role, n);
			return { stack, template: Template.fromStack(stack) };
		};
		let inlineCases = 0;
		let overflowCases = 0;
		for (let n = range[0]; n <= range[1]; n++) {
			const unpacked = build(false, n).template;
			const packed = build(true, n);
			assert.deepStrictEqual(driftWarnings(packed.stack), [], `drift warning at ${n} statements`);
			if (hasOverflow(unpacked)) {
				overflowCases++;
				continue;
			}
			inlineCases++;
			assert.strictEqual(
				JSON.stringify(packed.template.toJSON()),
				JSON.stringify(unpacked.toJSON()),
				`template changed at ${n} statements, where CDK leaves the policy inline`,
			);
		}
		// Well clear of the threshold on both sides, so a shift in either direction is caught.
		assert.ok(
			inlineCases >= 10 && overflowCases >= 10,
			`the range should straddle CDK’s split threshold: ${inlineCases} inline, ${overflowCases} overflowing`,
		);
	}

	test('around CDK’s split threshold with token resources, the template is unchanged whenever CDK creates no overflow', () => {
		assertUnchangedAroundThreshold(
			(stack, role, n) => {
				const bucket = new s3.Bucket(stack, 'Bucket');
				// Combinable statements with token resources: CDK sizes each token with its estimate,
				// so consolidation turning on below CDK's threshold would show up as merged statements.
				for (let i = 0; i < n; i++) {
					role.addToPrincipalPolicy(
						new iam.PolicyStatement({
							actions: SHARED_ACTIONS,
							resources: [bucket.arnForObjects(`p${i}/*`)],
						}),
					);
				}
			},
			[10, 70],
		);
	});

	test('around CDK’s split threshold with literal resources, the template is unchanged whenever CDK creates no overflow', () => {
		// Literal ARNs are sized by their exact length rather than the token estimate.
		assertUnchangedAroundThreshold((_stack, role, n) => addCombinable(role, n), [15, 75]);
	});

	test('uses aws-cdk-lib’s own size estimator', () => {
		const { stack, role } = makeRole({ packing: true });
		addCombinable(role, 150);
		Template.fromStack(stack);
		const fallback = Annotations.fromStack(stack).findInfo(
			'*',
			Match.stringLikeRegexp("doesn't expose the policy size estimate"),
		);
		assert.deepStrictEqual(fallback, []);
	});

	test('warns when CDK’s split uses a different inline threshold than the packing assumed', () => {
		const { stack, role } = makeRole({ packing: true });
		addCombinable(role, 45);
		// Simulate an aws-cdk-lib whose split keeps up to 12,000 characters inline: the packing
		// still turns merging on at 10,000, so the role's policy changes where CDK wouldn't split.
		type Splittable = { _splitDocument: (scope: unknown, self: number, split: number) => unknown };
		const splitter = role as unknown as { splitLargePolicy: () => void; defaultPolicy?: iam.Policy };
		const realSplit = splitter.splitLargePolicy;
		splitter.splitLargePolicy = function (this: typeof splitter) {
			const doc = this.defaultPolicy?.document as unknown as Splittable;
			const inner = doc._splitDocument;
			doc._splitDocument = (scope, _self, split) => inner.call(doc, scope, 12_000, split);
			realSplit.call(this);
		};

		const template = Template.fromStack(stack);
		assert.ok(!hasOverflow(template), 'nothing overflows at the simulated threshold');
		const warnings = driftWarnings(stack);
		assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
		assert.match(
			String(warnings[0].entry.data),
			/split at an estimated 12000 characters, AWS Blocks expected 10000/,
		);
		assert.match(String(warnings[0].entry.data), /consolidated without overflowing/);
	});

	test('adds an info annotation when CDK keeps the minimize field but no longer merges', () => {
		type Mergeable = { shouldMerge: (scope: unknown) => boolean };
		const proto = iam.PolicyDocument.prototype as unknown as Mergeable;
		const realShouldMerge = proto.shouldMerge;
		// Simulate an aws-cdk-lib that still has a writable `minimize` field but ignores it.
		proto.shouldMerge = () => false;
		try {
			const { stack, role } = makeRole({ packing: true });
			addCombinable(role, 150);
			const template = Template.fromStack(stack);
			assert.strictEqual(statementCount(template), 150, 'nothing merged');
			Annotations.fromStack(stack).hasInfo(
				'/PackingStack/Role',
				Match.stringLikeRegexp("didn't merge statements through PolicyDocument's 'minimize' field"),
			);
			assert.deepStrictEqual(driftWarnings(stack), []);
		} finally {
			proto.shouldMerge = realShouldMerge;
		}
	});

	test('adds no merge info annotation when merging took effect', () => {
		const { stack, role } = makeRole({ packing: true });
		addCombinable(role, 150);
		Template.fromStack(stack);
		const info = Annotations.fromStack(stack).findInfo('*', Match.stringLikeRegexp("didn't merge statements"));
		assert.deepStrictEqual(info, []);
		assert.deepStrictEqual(driftWarnings(stack), []);
	});

	test('skips consolidation with an info annotation when CDK no longer exposes the minimize field', () => {
		const { stack, role } = makeRole({ packing: true });
		addCombinable(role, 150);
		const document = (role.node.findChild('DefaultPolicy') as iam.Policy).document;
		// Simulate an aws-cdk-lib version without the field the consolidation sets.
		delete (document as unknown as { minimize?: boolean }).minimize;

		const template = Template.fromStack(stack);
		assert.strictEqual(statementCount(template), 150, 'nothing merged');
		Annotations.fromStack(stack).hasInfo(
			'/PackingStack/Role',
			Match.stringLikeRegexp("didn't merge statements through PolicyDocument's 'minimize' field"),
		);
	});
});

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
				assert.match(err.message, /PackingStack\.blocks-iam\.json/);
				assert.match(err.message, /separate Blocks backend \(another BlocksStack or BlocksBackend\)/);
				assert.ok(err.message.includes(MANAGED_POLICIES_PER_ROLE_QUOTA_CONTEXT_KEY), err.message);
				return true;
			},
		);
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
		assert.throws(() => app.synth(), /OverQuotaStack\/BlocksRole needs \d+ managed policies/);
	});
});
