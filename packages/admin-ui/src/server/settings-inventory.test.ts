// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { BlockSettingDeclaration, DiscoveredBlock } from '../contract/v1.js';
import type { RawTemplate } from './resources.js';
import {
	decodeSettingValue,
	declaredSettings,
	encodeSettingValue,
	cloudAddressFor,
	joinSettings,
	SETTING_VALUE_MAX_BYTES,
	templateParameterNames,
} from './settings-inventory.js';

/** An AppSetting declaration as `block-discovery` reports one. */
function setting(id: string, declaration: Partial<BlockSettingDeclaration> = {}): DiscoveredBlock {
	return {
		type: 'AppSetting',
		id,
		fullId: `shop-${id}`,
		category: 'config',
		file: 'aws-blocks/index.ts',
		line: 1,
		setting: {
			parameterName: `/shop-${id}`,
			nameSource: 'derived',
			secret: false,
			hasSchema: false,
			external: false,
			...declaration,
		},
	};
}

/** A block that carries no value, so no settings row. */
function store(id: string): DiscoveredBlock {
	return {
		type: 'KVStore',
		id,
		fullId: `shop-${id}`,
		category: 'data',
		file: 'aws-blocks/index.ts',
		line: 2,
	};
}

describe('encodeSettingValue — the encoding the runtime reads', () => {
	/**
	 * The trap this function exists for. `get()` runs `JSON.parse`, so storing
	 * the typed text verbatim changes the TYPE of the value the app receives,
	 * on exactly the inputs a config field attracts.
	 */
	it('keeps text that looks like JSON a string through a full round trip', () => {
		for (const input of ['5', 'true', 'false', 'null', '{"a":1}', '[]', '"quoted"', '1e3']) {
			const result = encodeSettingValue(input, 'text', { secret: false });
			assert.ok(result.ok, `${input} should encode`);
			const read = decodeSettingValue(result.encoded);
			assert.strictEqual(read.value, input, `${input} must come back as the same string`);
			assert.strictEqual(read.encoding, 'json');
		}
	});

	it('stores a JSON value as a value, not as its source text', () => {
		const result = encodeSettingValue('{"retries": 3}', 'json', { secret: false });
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { retries: 3 });
		// Re-serialized rather than passed through, so stored bytes do not carry
		// the user's whitespace.
		assert.strictEqual(result.encoded, '{"retries":3}');
		assert.deepStrictEqual(decodeSettingValue(result.encoded).value, { retries: 3 });
	});

	it('rejects input the user called JSON but is not', () => {
		const result = encodeSettingValue("{retries: 3}", 'json', { secret: false });
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.ok === false && result.reason, 'invalid-json');
		// The message names the way out, because storing it as text is a real
		// and often correct answer.
		assert.match(result.ok === false ? result.message : '', /text/);
	});

	it('refuses to empty a secret, which breaks the app at its next read', () => {
		const result = encodeSettingValue('', 'text', { secret: true });
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.ok === false && result.reason, 'empty-secret');
		assert.match(result.ok === false ? result.message : '', /ParameterNotFound/);
	});

	it('allows an empty plain value, which is a legal setting', () => {
		const result = encodeSettingValue('', 'text', { secret: false });
		assert.ok(result.ok);
		assert.strictEqual(result.encoded, '""');
	});

	it('rejects a value over the SSM limit, measured on the encoded bytes', () => {
		// Encoding adds the quotes, so a value measured on the raw input would
		// pass at exactly the limit and then fail at the API.
		const atLimit = 'a'.repeat(SETTING_VALUE_MAX_BYTES - 2);
		assert.ok(encodeSettingValue(atLimit, 'text', { secret: false }).ok);

		const overLimit = 'a'.repeat(SETTING_VALUE_MAX_BYTES - 1);
		const result = encodeSettingValue(overLimit, 'text', { secret: false });
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.ok === false && result.reason, 'too-large');
	});

	it('measures bytes rather than characters', () => {
		// Four bytes per emoji in UTF-8, so a character count would accept a
		// value SSM then rejects.
		const emoji = '\u{1F512}'.repeat(SETTING_VALUE_MAX_BYTES / 4);
		const result = encodeSettingValue(emoji, 'text', { secret: false });
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.ok === false && result.reason, 'too-large');
	});
});

describe('decodeSettingValue', () => {
	it('reports a pre-JSON stored value as raw, so a re-save is not called a no-op', () => {
		assert.deepStrictEqual(decodeSettingValue('plain-old-value'), {
			value: 'plain-old-value',
			encoding: 'raw',
		});
	});

	it('reads a value written by the current encoding', () => {
		assert.deepStrictEqual(decodeSettingValue('"on"'), { value: 'on', encoding: 'json' });
		assert.deepStrictEqual(decodeSettingValue('3'), { value: 3, encoding: 'json' });
	});
});

describe('templateParameterNames', () => {
	it('collects plain parameters by name', () => {
		const template: RawTemplate = {
			Resources: {
				Flag: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/shop-flag' } },
				Table: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'orders' } },
			},
		};

		assert.deepStrictEqual(templateParameterNames(template), {
			names: ['/shop-flag'],
			complete: true,
		});
	});

	/**
	 * CloudFormation cannot create a SecureString, so the framework creates all
	 * of a stack's secrets through one custom resource. Reading only
	 * `AWS::SSM::Parameter` would report every secret as undeployed.
	 */
	it('collects secrets from the custom resource that creates them', () => {
		const template: RawTemplate = {
			Resources: {
				BlocksSecretsBulk: {
					Type: 'AWS::CloudFormation::CustomResource',
					Properties: { ParameterNames: ['/shop-token', '/shop-key'], StackName: 'shop' },
				},
			},
		};

		assert.deepStrictEqual(templateParameterNames(template), {
			names: ['/shop-token', '/shop-key'],
			complete: true,
		});
	});

	it('marks the list incomplete when a parameter name is an intrinsic', () => {
		const template: RawTemplate = {
			Resources: {
				Flag: { Type: 'AWS::SSM::Parameter', Properties: { Name: { Ref: 'Something' } } },
			},
		};

		assert.deepStrictEqual(templateParameterNames(template), { names: [], complete: false });
	});

	it('marks the list incomplete when the secrets resource hides its names', () => {
		// The resource is present, so the stack HAS secrets. An empty list here
		// would read as "no secrets" and turn every declared secret into absent.
		const template: RawTemplate = {
			Resources: {
				BlocksSecretsBulk: {
					Type: 'AWS::CloudFormation::CustomResource',
					Properties: { ParameterNames: { 'Fn::GetAtt': ['X', 'Names'] } },
				},
			},
		};

		assert.deepStrictEqual(templateParameterNames(template), { names: [], complete: false });
	});

	it('keeps the resolvable names when only one entry is an intrinsic', () => {
		const template: RawTemplate = {
			Resources: {
				BlocksSecretsBulk: {
					Type: 'AWS::CloudFormation::CustomResource',
					Properties: { ParameterNames: ['/shop-token', { Ref: 'Other' }] },
				},
			},
		};

		assert.deepStrictEqual(templateParameterNames(template), {
			names: ['/shop-token'],
			complete: false,
		});
	});

	it('reads an empty template as complete and empty', () => {
		assert.deepStrictEqual(templateParameterNames({}), { names: [], complete: true });
	});
});

describe('cloudAddressFor', () => {
	/**
	 * The bug a real deploy found, and that every unit fixture had missed.
	 * `fullId` walks the scope's parent chain, and in a deployed stack the
	 * Scope's parent is the stack, so the synthesized path is
	 * `/${stackName}-${fullId}`. Deriving `/${fullId}` reported rota's one
	 * setting as absent in its own sandbox AND listed its parameter as an
	 * orphan, in the same response.
	 */
	it('resolves the stack-prefixed path a deployed stack actually creates', () => {
		const names = [
			'/rota-3a4f18-dev-bf9209-rota-auth-jwt-secret',
			'/rota-3a4f18-dev-bf9209-rota-min-educators',
		];

		assert.equal(
			cloudAddressFor(
				{ parameterName: '/rota-min-educators', nameSource: 'derived', secret: false, hasSchema: false, external: false },
				'rota-min-educators',
				names,
				'rota-3a4f18-dev-bf9209',
			),
			'/rota-3a4f18-dev-bf9209-rota-min-educators',
		);
	});

	it('prefers an exact unprefixed match when the template carries one', () => {
		assert.equal(
			cloudAddressFor(
				{ nameSource: 'derived', secret: false, hasSchema: false, external: false },
				'shop-flag',
				['/shop-flag', '/stack-shop-flag'],
				'stack',
			),
			'/shop-flag',
		);
	});

	it('passes an explicitly named parameter through literally', () => {
		// The CDK layer uses `options.name` verbatim, with no stack prefix, so
		// suffix-matching it would be wrong.
		assert.equal(
			cloudAddressFor(
				{ parameterName: '/shared/flag', nameSource: 'explicit', secret: false, hasSchema: false, external: false },
				'shop-flag',
				['/stack-shop-flag'],
				'stack',
			),
			'/shared/flag',
		);
	});

	/**
	 * Why this is an exact build from the stack name rather than a suffix
	 * match: `/stack-rota-min-educators` DOES end with `-educators`, so a
	 * sibling declaration named `educators` would claim another setting's
	 * parameter and the dashboard would edit the wrong value.
	 */
	it('does not let one declaration claim another setting whose id it ends', () => {
		assert.equal(
			cloudAddressFor(
				{ nameSource: 'derived', secret: false, hasSchema: false, external: false },
				'educators',
				['/stack-rota-min-educators'],
				'stack',
			),
			undefined,
		);
	});

	/**
	 * The same rule at the other boundary: a parameter living under a path
	 * segment ENDS with the derived candidate without being it. Matching by
	 * suffix would hand this declaration somebody else's parameter, which the
	 * exact comparison refuses.
	 */
	it('does not claim a parameter nested under another path that merely ends the same', () => {
		assert.equal(
			cloudAddressFor(
				{ nameSource: 'derived', secret: false, hasSchema: false, external: false },
				'shop-flag',
				['/tenant-b/stack-shop-flag', '/legacy/shop-flag'],
				'stack',
			),
			undefined,
		);
	});

	it('resolves nothing when the stack creates no matching parameter', () => {
		// Which is the truth: the fix is a deploy, not a write to a guessed path.
		assert.equal(
			cloudAddressFor(
				{ nameSource: 'derived', secret: false, hasSchema: false, external: false },
				'shop-flag',
				['/shop-other'],
				'stack',
			),
			undefined,
		);
	});

	it('resolves nothing for a path that was never nameable', () => {
		assert.equal(
			cloudAddressFor(
				{ nameSource: 'unresolved', secret: true, hasSchema: false, external: true },
				'shop-db-url',
				['/stack-shop-db-url'],
				'stack',
			),
			undefined,
		);
	});
});

describe('joinSettings', () => {
	it('keeps only blocks that carry a value', () => {
		const blocks = [setting('flag'), store('cache'), setting('token', { secret: true })];

		assert.deepStrictEqual(
			declaredSettings(blocks).map((block) => block.id),
			['flag', 'token'],
		);
		const inventory = joinSettings({ blocks, mode: 'cloud', live: [], addresses: new Map() });
		assert.deepStrictEqual(
			inventory.settings.map((row) => row.id),
			['flag', 'token'],
		);
	});

	it('addresses a deployed stage by parameter path', () => {
		const inventory = joinSettings({
			blocks: [setting('flag'), setting('token')],
			mode: 'cloud',
			live: ['/shop-flag'],
			addresses: new Map([
				['shop-flag', '/shop-flag'],
				['shop-token', '/shop-token'],
			]),
		});

		assert.deepStrictEqual(
			inventory.settings.map((row) => [row.address, row.presence]),
			[
				['/shop-flag', 'present'],
				['/shop-token', 'absent'],
			],
		);
	});

	/**
	 * The mock keys `.bb-data/settings.json` by `fullId`, not by SSM path, so a
	 * join that used one address space for both modes would report every local
	 * setting as undeclared and every declaration as absent.
	 */
	it('addresses local mode by fullId, not by parameter path', () => {
		const inventory = joinSettings({
			blocks: [setting('flag', { parameterName: '/shared/flag', nameSource: 'explicit' })],
			mode: 'local',
			live: ['shop-flag'],
		});

		assert.strictEqual(inventory.settings[0]?.address, 'shop-flag');
		assert.strictEqual(inventory.settings[0]?.presence, 'present');
		assert.deepStrictEqual(inventory.orphans, []);
	});

	it('leaves a setting it cannot address unknown rather than absent', () => {
		const inventory = joinSettings({
			blocks: [setting('db-url', { nameSource: 'unresolved', parameterName: undefined, secret: true })],
			mode: 'cloud',
			live: ['/seeded/db'],
			addresses: new Map(),
		});

		assert.strictEqual(inventory.settings[0]?.address, undefined);
		// Not `absent`: the parameter may well be the live one below, and
		// claiming it is missing invites a deploy that is not needed.
		assert.strictEqual(inventory.settings[0]?.presence, 'unknown');
		assert.strictEqual(inventory.settings[0]?.secret, true);
		assert.deepStrictEqual(inventory.orphans, ['/seeded/db']);
	});

	it('reports a live parameter no declaration claims', () => {
		const inventory = joinSettings({
			blocks: [setting('flag')],
			mode: 'cloud',
			live: ['/shop-flag', '/shop-removed'],
			addresses: new Map([['shop-flag', '/shop-flag']]),
		});

		assert.deepStrictEqual(inventory.orphans, ['/shop-removed']);
	});

	it('carries the declaration facts a reader needs through the join', () => {
		const inventory = joinSettings({
			blocks: [setting('limits', { hasSchema: true, external: true, secret: true })],
			mode: 'cloud',
			live: ['/shop-limits'],
			addresses: new Map([['shop-limits', '/shop-limits']]),
		});

		assert.deepStrictEqual(inventory.settings[0], {
			fullId: 'shop-limits',
			id: 'limits',
			file: 'aws-blocks/index.ts',
			line: 1,
			address: '/shop-limits',
			presence: 'present',
			secret: true,
			hasSchema: true,
			external: true,
			nameSource: 'derived',
		});
	});
});
