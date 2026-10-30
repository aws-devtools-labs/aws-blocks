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
import {
	BASELINE_WRITE_VERSION,
	baselinePath,
	checkBaseline,
	rebaselineRequested,
} from './cdk/immutability-baseline.js';

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

	/**
	 * A baseline exactly as earlier builds wrote and apps committed it. Frozen
	 * bytes: if `serialize` changes, a committed file churns on the next synth
	 * (or, worse, stops parsing) — that needs a deliberate format decision.
	 */
	const COMMITTED_V1 = `${JSON.stringify(
		{
			$comment:
				'Generated by @aws-blocks/bb-auth at synth. Commit this file. It records the user-pool properties Cognito ' +
				'cannot change after creation; a synth that changes one fails. Do not edit by hand — re-baseline with ' +
				'BLOCKS_AUTH_REBASELINE=MyApp-prod-auth.',
			version: 1,
			stack: 'MyApp-prod',
			fullId: 'MyApp-prod-auth',
			ownsPool: true,
			pool: {
				version: 1,
				usernameAttributes: [],
				aliasAttributes: ['email'],
				caseSensitive: null,
				requiredAttributes: [],
				customAttributes: {
					tenant: { type: 'String', mutable: true, developerOnly: null, constraints: null },
				},
			},
			removalGuard: {
				deletes: "the Cognito user pool 'MyApp-prod-auth' and every user in it",
				rebaselineEnv: 'BLOCKS_AUTH_REBASELINE',
				runbook: '"Renaming or removing an Auth block" in the @aws-blocks/bb-auth DESIGN.md',
			},
		},
		null,
		'\t',
	)}\n`;

	test('a committed version-1 baseline is read unchanged: no rewrite, its immutables still enforced', () => {
		const f = file();
		checkBaseline(input(f, owned(base())));
		writeFileSync(f, COMMITTED_V1);
		assert.strictEqual(checkBaseline(input(f, owned(base()))).status, 'unchanged');
		assert.strictEqual(readFileSync(f, 'utf8'), COMMITTED_V1, 'byte-identical: upgrading causes no diff');
		const changed = checkBaseline(
			input(f, owned(snapshotFromTemplate({ usernameAttributes: ['email'], schema: BASE_L1.schema }))),
		);
		assert.strictEqual(changed.status, 'rejected');
		assert.strictEqual(readFileSync(f, 'utf8'), COMMITTED_V1);
	});

	test('a committed baseline without `version` is read as version 1 (guarded change refused, pool removal refused)', () => {
		const { version, ...rest } = JSON.parse(COMMITTED_V1) as Record<string, unknown>;
		assert.strictEqual(version, 1);
		const withoutVersion = `${JSON.stringify(rest, null, '\t')}\n`;
		const f = file();
		checkBaseline(input(f, owned(base())));

		writeFileSync(f, withoutVersion);
		const changed = checkBaseline(
			input(f, owned(snapshotFromTemplate({ usernameAttributes: ['email'], schema: BASE_L1.schema }))),
		);
		assert.strictEqual(changed.status, 'rejected');
		assert.ok(changed.status === 'rejected' && changed.violations.length > 0, 'a real immutable violation');
		assert.strictEqual(readFileSync(f, 'utf8'), withoutVersion, 'a rejected synth leaves the file untouched');

		const removed = checkBaseline(input(f, { ownsPool: false, pool: null }));
		assert.ok(removed.status === 'rejected' && removed.violations[0].property === 'poolRemoved');

		assert.strictEqual(checkBaseline(input(f, owned(base()))).status, 'updated');
		assert.strictEqual(
			readFileSync(f, 'utf8'),
			COMMITTED_V1,
			'the permitted synth adds `version: 1` and nothing else',
		);
	});

	const withVersion = (version: unknown) =>
		`${JSON.stringify({ ...(JSON.parse(COMMITTED_V1) as object), version }, null, '\t')}\n`;

	test('a newer format version fails closed with an upgrade message, and the file is not touched', () => {
		for (const version of [2, 3, 100]) {
			const f = file();
			checkBaseline(input(f, owned(base())));
			const content = withVersion(version);
			writeFileSync(f, content);
			const out = checkBaseline(input(f, owned(base())));
			assert.ok(out.status === 'rejected' && out.violations.length === 0, `version ${version}`);
			assert.ok(
				out.status === 'rejected' && out.message.includes(`uses format version ${version}, written by a newer`),
			);
			assert.ok(out.status === 'rejected' && /reads versions 1 to 1/.test(out.message));
			assert.ok(
				out.status === 'rejected' && /Upgrade @aws-blocks\/bb-auth and @aws-blocks\/core/.test(out.message),
			);
			assert.strictEqual(readFileSync(f, 'utf8'), content, `version ${version} not overwritten`);
		}
	});

	test('a `version` that is not a positive integer is an invalid file: restore it, and it is not touched', () => {
		for (const version of ['1', 0, -1, null, 1.5, true]) {
			const f = file();
			checkBaseline(input(f, owned(base())));
			const content = withVersion(version);
			writeFileSync(f, content);
			const out = checkBaseline(input(f, owned(base())));
			assert.ok(out.status === 'rejected' && out.violations.length === 0, `version ${JSON.stringify(version)}`);
			assert.ok(out.status === 'rejected' && out.message.includes('is not a valid baseline file'));
			assert.ok(out.status === 'rejected' && out.message.includes(`\`version\` is\n${JSON.stringify(version)},`));
			assert.ok(out.status === 'rejected' && /Restore it from version control/.test(out.message));
			assert.ok(out.status === 'rejected' && !/newer/.test(out.message));
			assert.strictEqual(readFileSync(f, 'utf8'), content, `version ${JSON.stringify(version)} not overwritten`);
		}
	});

	test('BLOCKS_AUTH_REBASELINE refuses to overwrite a newer or invalid baseline', () => {
		for (const [version, message] of [
			[2, /does not re-baseline over it: that would replace a newer file with an older format/],
			[0, /does not overwrite it\. To start a fresh baseline deliberately, delete the file first/],
		] as const) {
			const f = file();
			checkBaseline(input(f, owned(base())));
			const content = withVersion(version);
			writeFileSync(f, content);
			const out = checkBaseline(input(f, owned(base()), true));
			assert.strictEqual(out.status, 'rejected', `version ${version}`);
			assert.ok(
				out.status === 'rejected' && message.test(out.message),
				out.status === 'rejected' ? out.message : '',
			);
			assert.strictEqual(readFileSync(f, 'utf8'), content, 'the file is left as it is');
		}
		// A supported (or version-less) file still re-baselines.
		const f = file();
		checkBaseline(input(f, owned(base())));
		writeFileSync(f, withVersion(1));
		assert.strictEqual(checkBaseline(input(f, owned(base()), true)).status, 'rebaselined');
	});

	test('bb-auth writes format version 1 whatever core supports, and refuses a core too old to read it', () => {
		// The literal this build writes — deliberately not core's BASELINE_FORMAT_VERSION.
		assert.strictEqual(BASELINE_WRITE_VERSION, 1);
		for (const coreFormatVersion of [1, 2, 5]) {
			const f = file();
			assert.strictEqual(checkBaseline({ ...input(f, owned(base())), coreFormatVersion }).status, 'created');
			assert.strictEqual(
				(JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>).version,
				1,
				`core reads up to ${coreFormatVersion}`,
			);
			// A version-1 file is read whatever core supports.
			writeFileSync(f, COMMITTED_V1);
			assert.strictEqual(checkBaseline({ ...input(f, owned(base())), coreFormatVersion }).status, 'unchanged');
			// A file above what this build writes (a newer bb-auth's) is never rewritten as version 1,
			// even when core could read it: this build would drop fields it does not know.
			if (coreFormatVersion > 1) {
				const newer = withVersion(2);
				writeFileSync(f, newer);
				const out = checkBaseline({ ...input(f, owned(base())), coreFormatVersion });
				assert.ok(
					out.status === 'rejected' && out.message.includes('uses format version 2, written by a newer'),
				);
				assert.strictEqual(readFileSync(f, 'utf8'), newer);
			}
		}
		const f = file();
		const out = checkBaseline({ ...input(f, owned(base())), coreFormatVersion: 0 });
		assert.ok(
			out.status === 'rejected' && /installed @aws-blocks\/core reads versions 1 to 0 only/.test(out.message),
		);
		assert.ok(!existsSync(f), 'nothing written');
	});

	test('a pool-less baseline without `version` is read as version 1', () => {
		const f = file();
		checkBaseline(input(f, { ownsPool: false, pool: null }));
		const { version, ...rest } = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
		assert.strictEqual(version, 1);
		assert.strictEqual(rest.removalGuard, undefined);
		writeFileSync(f, `${JSON.stringify(rest, null, '\t')}\n`);
		assert.strictEqual(checkBaseline(input(f, owned(base()))).status, 'updated', 'adding a pool is permitted');
	});

	test('BLOCKS_AUTH_REBASELINE must name the block', () => {
		assert.strictEqual(rebaselineRequested({}, 'A-auth'), false);
		assert.strictEqual(rebaselineRequested({ BLOCKS_AUTH_REBASELINE: '1' }, 'A-auth'), false);
		assert.strictEqual(rebaselineRequested({ BLOCKS_AUTH_REBASELINE: 'B-auth, A-auth' }, 'A-auth'), true);
	});
});
