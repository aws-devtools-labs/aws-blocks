// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared immutability diff (`cdk/immutability.ts`) and the baseline file
 * (`cdk/immutability-baseline.ts`), without synth. The end-to-end pairs —
 * permitted vs guarded changes through a real synth and the deploy-time
 * handler — are in `immutability-guard.cdk.test.ts`.
 */

import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
	diffImmutables,
	type PoolImmutables,
	parseSnapshot,
	snapshotFromLive,
	snapshotFromTemplate,
} from './cdk/immutability.js';
import { baselinePath, checkBaseline, rebaselineRequested } from './cdk/immutability-baseline.js';

/** The CDK L1 shape of `Auth`'s default pool with one custom attribute. */
const BASE_L1 = {
	aliasAttributes: ['email'],
	schema: [{ attributeDataType: 'String', mutable: true, name: 'tenant' }],
};
const base = (): PoolImmutables => snapshotFromTemplate(BASE_L1);

describe('snapshotFromTemplate', () => {
	test('reads L1 (camelCase) and CloudFormation (PascalCase) props identically', () => {
		const fromCfn = snapshotFromTemplate({
			aliasAttributes: ['email'],
			schema: [{ AttributeDataType: 'String', Mutable: true, Name: 'tenant' }],
		});
		assert.deepStrictEqual(fromCfn, base());
	});

	test('a standard attribute in Schema counts only when Required; any other name is a custom attribute', () => {
		const s = snapshotFromTemplate({
			schema: [
				{ name: 'email', required: true, mutable: true },
				{ name: 'given_name', required: false },
				{
					name: 'age',
					attributeDataType: 'Number',
					mutable: false,
					numberAttributeConstraints: { minValue: 0 },
				},
			],
		});
		assert.deepStrictEqual(s.requiredAttributes, ['email']);
		assert.deepStrictEqual(Object.keys(s.customAttributes), ['age']);
		assert.deepStrictEqual(s.customAttributes.age, {
			type: 'Number',
			mutable: false,
			developerOnly: null,
			constraints: { minValue: '0' },
		});
	});

	test('UsernameConfiguration unset → caseSensitive null', () => {
		assert.strictEqual(base().caseSensitive, null);
		assert.strictEqual(
			snapshotFromTemplate({ usernameConfiguration: { caseSensitive: false } }).caseSensitive,
			false,
		);
	});
});

describe('snapshotFromLive', () => {
	test('strips custom: / dev:custom:, and never lists sub as required', () => {
		const s = snapshotFromLive({
			AliasAttributes: ['email'],
			UsernameConfiguration: { CaseSensitive: true },
			SchemaAttributes: [
				{ Name: 'sub', AttributeDataType: 'String', Mutable: false, Required: true },
				{ Name: 'email', AttributeDataType: 'String', Mutable: true, Required: false },
				{
					Name: 'custom:tenant',
					AttributeDataType: 'String',
					Mutable: true,
					Required: false,
					DeveloperOnlyAttribute: false,
					StringAttributeConstraints: { MaxLength: '2048' },
				},
				{ Name: 'dev:custom:legacy', AttributeDataType: 'String', Mutable: true, DeveloperOnlyAttribute: true },
			],
		});
		assert.deepStrictEqual(s.requiredAttributes, []);
		assert.deepStrictEqual(Object.keys(s.customAttributes), ['legacy', 'tenant']);
		assert.strictEqual(s.caseSensitive, true);
	});
});

describe('diffImmutables', () => {
	test('identical → no violation', () => {
		assert.deepStrictEqual(diffImmutables(base(), base()), []);
	});

	test('adding a custom attribute is permitted; removing or changing one is not', () => {
		const added = snapshotFromTemplate({
			...BASE_L1,
			schema: [...BASE_L1.schema, { name: 'plan', attributeDataType: 'String', mutable: true }],
		});
		assert.deepStrictEqual(diffImmutables(base(), added), []);
		const removed = diffImmutables(added, base());
		assert.strictEqual(removed.length, 1);
		assert.match(removed[0].change, /custom:plan' removed/);
		const changed = diffImmutables(
			base(),
			snapshotFromTemplate({
				...BASE_L1,
				schema: [{ attributeDataType: 'String', mutable: false, name: 'tenant' }],
			}),
		);
		assert.strictEqual(changed[0].property, 'customAttribute');
		assert.match(changed[0].change, /mutable → String, immutable/);
	});

	test('sign-in attributes: alias → username attribute is a violation naming both lists', () => {
		const v = diffImmutables(
			base(),
			snapshotFromTemplate({ usernameAttributes: ['email'], schema: BASE_L1.schema }),
		);
		assert.strictEqual(v.length, 1);
		assert.strictEqual(v[0].property, 'signInAttributes');
		assert.match(v[0].change, /UsernameAttributes \[\] → \[email\]; AliasAttributes \[email\] → \[\]/);
		assert.match(v[0].why, /can't change this setting/);
	});

	test('CaseSensitive: unset equals true (Cognito default); false is a violation', () => {
		const explicitTrue = snapshotFromTemplate({ ...BASE_L1, usernameConfiguration: { caseSensitive: true } });
		assert.deepStrictEqual(diffImmutables(base(), explicitTrue), []);
		assert.deepStrictEqual(diffImmutables(explicitTrue, base()), []);
		const v = diffImmutables(
			base(),
			snapshotFromTemplate({ ...BASE_L1, usernameConfiguration: { caseSensitive: false } }),
		);
		assert.strictEqual(v[0].property, 'caseSensitive');
		assert.match(v[0].change, /true → false/);
	});

	test('required attributes: adding or removing one is a violation', () => {
		const withEmail = snapshotFromTemplate({
			...BASE_L1,
			schema: [...BASE_L1.schema, { name: 'email', required: true }],
		});
		assert.strictEqual(diffImmutables(base(), withEmail)[0].property, 'requiredAttributes');
		assert.strictEqual(diffImmutables(withEmail, base())[0].property, 'requiredAttributes');
	});

	test('live before-state: a default the template never mentioned is not a change', () => {
		const live = snapshotFromLive({
			AliasAttributes: ['email'],
			UsernameConfiguration: { CaseSensitive: true },
			SchemaAttributes: [
				{ Name: 'sub', Required: true, Mutable: false, AttributeDataType: 'String' },
				{
					Name: 'custom:tenant',
					AttributeDataType: 'String',
					Mutable: true,
					DeveloperOnlyAttribute: false,
					StringAttributeConstraints: { MinLength: '0', MaxLength: '2048' },
				},
			],
		});
		assert.deepStrictEqual(diffImmutables(live, base(), { beforeIsLive: true }), []);
		// Without the live flag, the defaulted constraints would read as a change.
		assert.strictEqual(diffImmutables(live, base()).length, 1);
		// A constraint the template does set is compared.
		const constrained = snapshotFromTemplate({
			...BASE_L1,
			schema: [{ ...BASE_L1.schema[0], stringAttributeConstraints: { maxLength: '64' } }],
		});
		assert.strictEqual(diffImmutables(live, constrained, { beforeIsLive: true }).length, 1);
	});

	test('a snapshot survives JSON (string or object) and a CloudFormation-stringified boolean', () => {
		assert.deepStrictEqual(parseSnapshot(JSON.stringify(base())), base());
		assert.deepStrictEqual(parseSnapshot({ ...base(), caseSensitive: 'false' })?.caseSensitive, false);
		assert.strictEqual(parseSnapshot({ ...base(), version: 99 }), undefined);
		assert.strictEqual(parseSnapshot('not json'), undefined);
	});
});

describe('checkBaseline (the file layer)', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	function file(): string {
		const dir = mkdtempSync(join(tmpdir(), 'bb-auth-baseline-'));
		dirs.push(dir);
		return baselinePath(dir, 'MyApp-prod', 'MyApp-prod-auth');
	}
	const owned = (pool: PoolImmutables) => ({ ownsPool: true, pool });
	const input = (f: string, current: { ownsPool: boolean; pool: PoolImmutables | null }, rebaseline = false) => ({
		file: f,
		stack: 'MyApp-prod',
		fullId: 'MyApp-prod-auth',
		current,
		rebaseline,
	});

	test('path: <appDir>/baselines/<stack>/<fullId>.auth-pool.json', () => {
		assert.strictEqual(
			baselinePath('/app/aws-blocks', 'S', 'S-auth'),
			join('/app/aws-blocks', 'baselines', 'S', 'S-auth.auth-pool.json'),
		);
	});

	test('no baseline → created; same config → unchanged; permitted change → updated', () => {
		const f = file();
		assert.strictEqual(checkBaseline(input(f, owned(base()))).status, 'created');
		assert.ok(existsSync(f));
		const written = readFileSync(f, 'utf8');
		assert.strictEqual(checkBaseline(input(f, owned(base()))).status, 'unchanged');
		assert.strictEqual(readFileSync(f, 'utf8'), written);
		const added = snapshotFromTemplate({
			...BASE_L1,
			schema: [...BASE_L1.schema, { name: 'plan', mutable: true }],
		});
		assert.strictEqual(checkBaseline(input(f, owned(added))).status, 'updated');
		// The updated baseline now protects the added attribute.
		assert.strictEqual(checkBaseline(input(f, owned(base()))).status, 'rejected');
	});

	test('a rejected change leaves the baseline untouched', () => {
		const f = file();
		checkBaseline(input(f, owned(base())));
		const before = readFileSync(f, 'utf8');
		const out = checkBaseline(
			input(f, owned(snapshotFromTemplate({ usernameAttributes: ['email'], schema: BASE_L1.schema }))),
		);
		assert.strictEqual(out.status, 'rejected');
		assert.strictEqual(readFileSync(f, 'utf8'), before);
	});

	test('pool removal is rejected; pool addition is permitted', () => {
		const f = file();
		checkBaseline(input(f, owned(base())));
		const out = checkBaseline(input(f, { ownsPool: false, pool: null }));
		assert.strictEqual(out.status, 'rejected');
		assert.ok(out.status === 'rejected' && out.violations[0].property === 'poolRemoved');
		const g = file();
		assert.strictEqual(checkBaseline(input(g, { ownsPool: false, pool: null })).status, 'created');
		assert.strictEqual(checkBaseline(input(g, owned(base()))).status, 'updated');
	});

	test('rebaseline accepts anything and rewrites the file', () => {
		const f = file();
		checkBaseline(input(f, owned(base())));
		assert.strictEqual(checkBaseline(input(f, { ownsPool: false, pool: null }, true)).status, 'rebaselined');
		assert.strictEqual(checkBaseline(input(f, { ownsPool: false, pool: null })).status, 'unchanged');
	});

	test('an unreadable or foreign baseline fails closed (never a silent pass)', () => {
		const f = file();
		checkBaseline(input(f, owned(base())));
		writeFileSync(f, '{ not json');
		const out = checkBaseline(input(f, owned(base())));
		assert.strictEqual(out.status, 'rejected');
		assert.ok(out.status === 'rejected' && /unreadable/.test(out.message));
	});

	test('BLOCKS_AUTH_REBASELINE must name the block', () => {
		assert.strictEqual(rebaselineRequested({}, 'A-auth'), false);
		assert.strictEqual(rebaselineRequested({ BLOCKS_AUTH_REBASELINE: '1' }, 'A-auth'), false);
		assert.strictEqual(rebaselineRequested({ BLOCKS_AUTH_REBASELINE: 'B-auth, A-auth' }, 'A-auth'), true);
	});
});
