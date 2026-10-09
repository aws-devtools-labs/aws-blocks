// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { NativeBindingRegistration, NativeDeclarationSource } from './native-catalogs.js';
import { type ValidatableMethod, validateNativeCatalogs } from './validate-native-catalogs.js';

const DART = { package: { name: 'example_iot_native', library: 'example_iot_native.dart' } };
const SWIFT = {
	package: { identity: 'example-iot-native', product: 'ExampleIotNative', module: 'ExampleIotNative' },
};
const ANDROID = {
	package: { group: 'com.example.blocks', artifact: 'iot-native', kotlinPackage: 'com.example.blocks.iot' },
};

function binding(overrides: Partial<NativeBindingRegistration> = {}): NativeBindingRegistration {
	return {
		id: 'example-device-link',
		kind: 'transferable',
		tag: 'example-iot/device-link',
		package: 'example-iot-native',
		export: 'deviceLink',
		abi: 'blocks-transferable-v1',
		genericArity: 0,
		...overrides,
	};
}

function source(overrides: Partial<NativeDeclarationSource> = {}): NativeDeclarationSource {
	return {
		sourcePackage: '@example/bb-iot',
		packages: [{ identity: 'example-iot-native', platforms: { dart: DART, swift: SWIFT, android: ANDROID } }],
		bindings: [binding()],
		...overrides,
	};
}

function transferableMethod(name: string, tag: string, typeArgs?: unknown): ValidatableMethod {
	const schema: Record<string, unknown> = { 'x-blocks-transferable': tag };
	if (typeArgs !== undefined) schema['x-blocks-type-args'] = typeArgs;
	return { name, result: { schema } };
}

function paths(errors: { path: string }[]): string[] {
	return errors.map((e) => e.path);
}

describe('validateNativeCatalogs — valid input', () => {
	it('accepts a well-formed package and binding', () => {
		assert.deepStrictEqual(validateNativeCatalogs([source()]), []);
	});

	it('accepts no declarations at all', () => {
		assert.deepStrictEqual(validateNativeCatalogs([]), []);
		assert.deepStrictEqual(validateNativeCatalogs([{ sourcePackage: '@example/bb-iot' }]), []);
	});

	it('accepts a package offered on only one platform', () => {
		const errors = validateNativeCatalogs([
			source({
				packages: [{ identity: 'example-iot-native', platforms: { dart: DART } }],
			}),
		]);
		assert.deepStrictEqual(errors, [], 'an absent platform is intentional absence, not an error');
	});

	it('applies the package rule to a binding of another kind', () => {
		const errors = validateNativeCatalogs([
			source({ bindings: [binding({ id: 'some-facade', kind: 'facade', package: 'not-registered' })] }),
		]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-bindings.bindings["some-facade"].package']);
	});

	it('applies the built-in tag rule to a binding of another kind', () => {
		const errors = validateNativeCatalogs([
			source({ bindings: [binding({ id: 'some-facade', kind: 'facade', tag: 'realtime/channel' })] }),
		]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-bindings.bindings["some-facade"].tag']);
		assert.match(errors[0].message, /built-in transferable/);
	});

	it('applies the tag-uniqueness rule across binding kinds', () => {
		const errors = validateNativeCatalogs([
			source({
				bindings: [binding({ id: 'a-transferable' }), binding({ id: 'b-facade', kind: 'facade' })],
			}),
		]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-bindings.bindings["b-facade"].tag']);
		assert.match(errors[0].message, /already bound by "a-transferable"/);
	});

	it('does not apply the transferable-only rules to a binding of another kind', () => {
		const errors = validateNativeCatalogs([
			source({ bindings: [binding({ id: 'some-facade', kind: 'facade', abi: 'facade-v1' })] }),
		]);
		assert.deepStrictEqual(errors, []);
	});

	it('still applies the structural checks to a binding of another kind', () => {
		const errors = validateNativeCatalogs([source({ bindings: [binding({ id: '', kind: 'facade' })] })]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-bindings.bindings[0].id']);
	});
});

describe('untrusted containers — collected, never thrown', () => {
	for (const [label, srcs] of [
		['packages is not an array', [{ sourcePackage: '@example/bb-iot', packages: 5 }]],
		['bindings is not an array', [{ sourcePackage: '@example/bb-iot', bindings: 5 }]],
		['packages is a string', [{ sourcePackage: '@example/bb-iot', packages: 'abc' }]],
		['source is null', [null]],
		['source is not an object', [42]],
		['sourcePackage is a symbol', [{ sourcePackage: Symbol('x'), packages: [{ identity: '', platforms: {} }] }]],
	] as [string, unknown[]][]) {
		it(`collects instead of throwing when ${label}`, () => {
			const errors = validateNativeCatalogs(srcs as never, []);
			assert.ok(Array.isArray(errors), 'must return the error list rather than throw');
		});
	}

	it('reports every malformed container', () => {
		for (const srcs of [
			[{ sourcePackage: '@example/bb-iot', packages: 5 }],
			[{ sourcePackage: '@example/bb-iot', bindings: 5 }],
			[{ sourcePackage: '@example/bb-iot', packages: 'abc' }],
			[null],
			[42],
		] as unknown[][]) {
			assert.ok(validateNativeCatalogs(srcs as never, []).length > 0, JSON.stringify(srcs));
		}
	});

	it('reports a non-array packages field once, not once per character', () => {
		const errors = validateNativeCatalogs([{ sourcePackage: '@example/bb-iot', packages: 'abc' }] as never, []);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-packages.packages']);
	});

	it('names an unusable sourcePackage rather than interpolating it', () => {
		const errors = validateNativeCatalogs(
			[{ sourcePackage: 42, packages: [{ identity: '', platforms: {} }] }] as never,
			[],
		);
		assert.match(errors[0].message, /<unknown block>/);
	});

	it('collects instead of throwing when a declaration has a throwing accessor', () => {
		const hostile: Record<string, unknown> = { identity: 'p' };
		Object.defineProperty(hostile, 'platforms', {
			get() {
				throw new Error('author-controlled text');
			},
			enumerable: true,
		});
		const errors = validateNativeCatalogs([{ sourcePackage: '@example/bb-iot', packages: [hostile] }] as never, []);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-packages']);
		assert.match(errors[0].message, /could not be read \(/);
		assert.ok(!errors[0].message.includes('author-controlled text'), 'must not echo the thrown message');
	});

	// Names the input class, not one instance: a fallback read can throw too.
	it('collects instead of throwing whatever the thrown value does on read', () => {
		const thrown: unknown[] = [
			new Proxy(
				{},
				{
					get() {
						throw new Error('proxy get');
					},
				},
			),
			{
				toString() {
					throw new Error('throwing toString');
				},
			},
			new TypeError('plain'),
		];
		for (const value of thrown) {
			const hostile: Record<string, unknown> = { identity: 'p' };
			Object.defineProperty(hostile, 'platforms', {
				get() {
					throw value;
				},
				enumerable: true,
			});
			const errors = validateNativeCatalogs(
				[{ sourcePackage: '@example/bb-iot', packages: [hostile] }] as never,
				[],
			);
			assert.deepStrictEqual(paths(errors), ['x-blocks-native-packages']);
			assert.ok(!errors[0].message.includes('proxy get'), 'must not echo the thrown message');
			assert.ok(!errors[0].message.includes('throwing toString'), 'must not echo the thrown message');
		}
	});

	it("never echoes the thrown value's message, even when it is a real Error", () => {
		for (const value of [
			Object.assign(new Error('SECRET_FROM_MESSAGE'), { name: 123 }),
			{
				toString() {
					return 'SECRET_FROM_TOSTRING';
				},
			},
		]) {
			const hostile: Record<string, unknown> = { identity: 'p' };
			Object.defineProperty(hostile, 'platforms', {
				get() {
					throw value;
				},
				enumerable: true,
			});
			const errors = validateNativeCatalogs(
				[{ sourcePackage: '@example/bb-iot', packages: [hostile] }] as never,
				[],
			);
			assert.deepStrictEqual(paths(errors), ['x-blocks-native-packages']);
			assert.ok(!errors[0].message.includes('SECRET'), `leaked: ${errors[0].message}`);
		}
	});

	it('treats a non-array container as nothing declared, not as an error', () => {
		// Both are unreachable through the declared types; the guards keep the
		// function total rather than relying on the catch.
		assert.deepStrictEqual(validateNativeCatalogs(null as never, []), []);
		assert.deepStrictEqual(validateNativeCatalogs([source()], null as never), []);
	});

	it('canonicalizes a reference cycle instead of exhausting the stack', () => {
		// Under a real platform key, so the cycle reaches canonicalJson rather
		// than being rejected as an unknown platform first.
		const cyclic: Record<string, unknown> = { name: 'n', library: 'l.dart' };
		cyclic.self = cyclic;
		const errors = validateNativeCatalogs(
			[
				{
					sourcePackage: '@example/a',
					packages: [{ identity: 'p', platforms: { dart: { package: cyclic } } }],
				},
				{ sourcePackage: '@example/b', packages: [{ identity: 'p', platforms: { dart: DART } }] },
			] as never,
			[],
		);
		// The two registrations differ, so rule 5 must fire — which it can only
		// do if canonicalJson returned rather than threw.
		assert.ok(
			errors.some((e) => /must be byte-identical/.test(e.message)),
			`expected a duplicate-identity error, got ${JSON.stringify(paths(errors))}`,
		);
	});
});

describe('rule 1 — a binding resolves to a registered package', () => {
	it('rejects a binding naming an unregistered package', () => {
		const errors = validateNativeCatalogs([source({ bindings: [binding({ package: 'not-registered' })] })]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-bindings.bindings["example-device-link"].package']);
		assert.match(errors[0].message, /not registered in x-blocks-native-packages/);
	});

	it('resolves a package registered by a different block', () => {
		const errors = validateNativeCatalogs([
			{
				sourcePackage: '@example/bb-iot-core',
				packages: [{ identity: 'shared-native', platforms: { dart: DART } }],
			},
			{ sourcePackage: '@example/bb-iot', bindings: [binding({ package: 'shared-native' })] },
		]);
		assert.deepStrictEqual(errors, []);
	});
});

describe('rule 2 — a tag is bound exactly once', () => {
	it('rejects the same tag bound by two blocks and names the first', () => {
		const errors = validateNativeCatalogs([
			source(),
			{ sourcePackage: '@example/bb-other', bindings: [binding({ id: 'other-link' })] },
		]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-bindings.bindings["other-link"].tag']);
		assert.match(errors[0].message, /already bound by "example-device-link"/);
		assert.match(errors[0].message, /@example\/bb-iot/);
	});

	it('rejects the same tag bound twice within one block', () => {
		const errors = validateNativeCatalogs([source({ bindings: [binding(), binding({ id: 'duplicate-link' })] })]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-bindings.bindings["duplicate-link"].tag']);
	});

	it('matches a tag byte-for-byte, so a near miss is allowed', () => {
		const errors = validateNativeCatalogs([source({ bindings: [binding({ tag: 'realtime/Channel' })] })]);
		assert.deepStrictEqual(errors, [], 'tag lookup is case-sensitive');
	});
});

describe('rule 4 — generic arity matches each method result', () => {
	it('accepts arity 0 against a result with no type args', () => {
		const errors = validateNativeCatalogs(
			[source({ bindings: [binding({ genericArity: 0 })] })],
			[transferableMethod('api.connectDevice', 'example-iot/device-link')],
		);
		assert.deepStrictEqual(errors, []);
	});

	it('accepts arity 1 against a result with one type arg', () => {
		const errors = validateNativeCatalogs(
			[source({ bindings: [binding({ genericArity: 1 })] })],
			[transferableMethod('api.connectDevice', 'example-iot/device-link', [{ type: 'object' }])],
		);
		assert.deepStrictEqual(errors, []);
	});

	it('rejects arity 1 against a result with no type args', () => {
		const errors = validateNativeCatalogs(
			[source({ bindings: [binding({ genericArity: 1 })] })],
			[transferableMethod('api.connectDevice', 'example-iot/device-link')],
		);
		assert.deepStrictEqual(paths(errors), ['methods["api.connectDevice"].result.schema.x-blocks-type-args']);
		assert.match(errors[0].message, /needs exactly 1 x-blocks-type-args entry, found 0/);
	});

	it('rejects arity 0 against a result that carries a type arg', () => {
		const errors = validateNativeCatalogs(
			[source({ bindings: [binding({ genericArity: 0 })] })],
			[transferableMethod('api.connectDevice', 'example-iot/device-link', [{ type: 'object' }])],
		);
		assert.match(errors[0].message, /needs exactly 0 x-blocks-type-args entries, found 1/);
	});

	it('reports every mismatching method, not just the first', () => {
		const errors = validateNativeCatalogs(
			[source({ bindings: [binding({ genericArity: 1 })] })],
			[
				transferableMethod('api.connectDevice', 'example-iot/device-link'),
				transferableMethod('api.connectOther', 'example-iot/device-link'),
			],
		);
		assert.deepStrictEqual(paths(errors), [
			'methods["api.connectDevice"].result.schema.x-blocks-type-args',
			'methods["api.connectOther"].result.schema.x-blocks-type-args',
		]);
	});

	it('ignores a method whose tag is not bound, which falls back to UnknownTransferable', () => {
		const errors = validateNativeCatalogs(
			[source()],
			[transferableMethod('api.getChannel', 'realtime/channel', [{ type: 'object' }])],
		);
		assert.deepStrictEqual(errors, [], 'an unbound tag is not this rule’s concern');
	});

	it('ignores results with no transferable tag', () => {
		const errors = validateNativeCatalogs(
			[source()],
			[{ name: 'api.plain', result: { schema: { type: 'string' } } }],
		);
		assert.deepStrictEqual(errors, []);
	});

	it('rejects a non-array type-args field rather than counting it as zero', () => {
		const errors = validateNativeCatalogs(
			[source({ bindings: [binding({ genericArity: 0 })] })],
			[transferableMethod('api.connectDevice', 'example-iot/device-link', 'not-an-array')],
		);
		assert.deepStrictEqual(paths(errors), ['methods["api.connectDevice"].result.schema.x-blocks-type-args']);
		assert.match(errors[0].message, /must be an array/);
	});

	it('rejects an arity outside the schema 1 range of zero and one', () => {
		const errors = validateNativeCatalogs([source({ bindings: [binding({ genericArity: 2 })] })]);
		assert.deepStrictEqual(paths(errors), [
			'x-blocks-native-bindings.bindings["example-device-link"].genericArity',
		]);
		assert.match(errors[0].message, /must be between 0 and 1 in schema 1, got 2/);
	});

	it('rejects a non-integer arity', () => {
		for (const genericArity of [1.5, Number.NaN, '1' as unknown as number, undefined as unknown as number]) {
			const errors = validateNativeCatalogs([source({ bindings: [binding({ genericArity })] })]);
			assert.strictEqual(errors.length, 1, `expected one error for ${String(genericArity)}`);
			assert.match(errors[0].message, /must be an integer/);
		}
	});
});

describe('rule 5 — a duplicate package identity must be byte-identical', () => {
	it('accepts an identical duplicate from two blocks', () => {
		const errors = validateNativeCatalogs([
			source(),
			{
				sourcePackage: '@example/bb-iot-extra',
				packages: [
					{ identity: 'example-iot-native', platforms: { dart: DART, swift: SWIFT, android: ANDROID } },
				],
			},
		]);
		assert.deepStrictEqual(errors, []);
	});

	it('accepts a duplicate whose keys are in a different order', () => {
		const errors = validateNativeCatalogs([
			source(),
			{
				sourcePackage: '@example/bb-iot-extra',
				packages: [
					{
						identity: 'example-iot-native',
						platforms: { android: ANDROID, swift: SWIFT, dart: DART },
					},
				],
			},
		]);
		assert.deepStrictEqual(errors, [], 'byte-identity is compared canonically, not by author order');
	});

	it('rejects a diverging duplicate and names both blocks', () => {
		const errors = validateNativeCatalogs([
			source(),
			{
				sourcePackage: '@example/bb-iot-extra',
				packages: [
					{
						identity: 'example-iot-native',
						platforms: { dart: { package: { name: 'other_name', library: 'other.dart' } } },
					},
				],
			},
		]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-packages.packages["example-iot-native"]']);
		assert.match(errors[0].message, /@example\/bb-iot and @example\/bb-iot-extra/);
		assert.match(errors[0].message, /must be byte-identical/);
	});
});

describe('rule 6 — malformed metadata', () => {
	it('rejects a blank package identity without faking a document path', () => {
		for (const identity of ['', '   ']) {
			const errors = validateNativeCatalogs([
				{ sourcePackage: '@example/bb-iot', packages: [{ identity, platforms: {} }] },
			]);
			assert.deepStrictEqual(paths(errors), ['x-blocks-native-packages.packages']);
			assert.match(errors[0].message, /must be a non-blank string, declaration 1/);
		}
	});

	it('rejects a binding id reused across blocks, so each diagnostic names one binding', () => {
		const errors = validateNativeCatalogs([
			source({ bindings: [binding({ id: 'dup', tag: 'example-iot/device-link' })] }),
			{ sourcePackage: '@example/bb-other', bindings: [binding({ id: 'dup', tag: 'example-iot/other' })] },
		]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-bindings.bindings["dup"].id']);
		assert.match(errors[0].message, /already declared by @example\/bb-iot/);
	});

	it('rejects a binding id reused twice within one block', () => {
		const errors = validateNativeCatalogs([
			source({
				bindings: [
					binding({ id: 'dup', tag: 'example-iot/device-link' }),
					binding({ id: 'dup', tag: 'example-iot/other' }),
				],
			}),
		]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-bindings.bindings["dup"].id']);
	});

	it('rejects a built-in tag without also reporting it as a duplicate', () => {
		const errors = validateNativeCatalogs([
			source({
				bindings: [
					binding({ id: 'b1', tag: 'realtime/channel' }),
					binding({ id: 'b2', tag: 'realtime/channel' }),
				],
			}),
		]);
		assert.deepStrictEqual(paths(errors), [
			'x-blocks-native-bindings.bindings["b1"].tag',
			'x-blocks-native-bindings.bindings["b2"].tag',
		]);
		assert.ok(
			errors.every((e) => /built-in transferable/.test(e.message)),
			'a rejected tag must not also be recorded as bound',
		);
	});

	it('rejects a binding with an empty kind', () => {
		const errors = validateNativeCatalogs([source({ bindings: [binding({ kind: '' })] })]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-bindings.bindings["example-device-link"].kind']);
	});

	it('rejects a missing platforms object', () => {
		const errors = validateNativeCatalogs([
			{
				sourcePackage: '@example/bb-iot',
				packages: [{ identity: 'p' } as unknown as { identity: string; platforms: never }],
			},
		]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-packages.packages["p"].platforms']);
	});

	it('rejects an unrecognized field on a registration', () => {
		const errors = validateNativeCatalogs([
			{
				sourcePackage: '@example/bb-iot',
				packages: [{ identity: 'p', platforms: { dart: DART }, delivery: { kind: 'npm' } } as never],
			},
		]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-packages.packages["p"].delivery']);
	});

	it('rejects a duplicate identity that differs only in an unrecognized field', () => {
		const errors = validateNativeCatalogs([
			{ sourcePackage: '@example/a', packages: [{ identity: 'p', platforms: { dart: DART } }] },
			{
				sourcePackage: '@example/b',
				packages: [{ identity: 'p', platforms: { dart: DART }, delivery: { kind: 'npm' } } as never],
			},
		]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-packages.packages["p"].delivery']);
	});

	it('rejects a negative generic arity', () => {
		const errors = validateNativeCatalogs([source({ bindings: [binding({ genericArity: -1 })] })]);
		assert.deepStrictEqual(paths(errors), [
			'x-blocks-native-bindings.bindings["example-device-link"].genericArity',
		]);
		assert.match(errors[0].message, /must be between 0 and 1/);
	});

	it('checks binding field shape for every kind, not just transferable', () => {
		const errors = validateNativeCatalogs([
			source({
				bindings: [
					{
						id: 'f1',
						kind: 'facade',
						tag: 'acme/thing',
						package: 'example-iot-native',
						export: 12345,
						abi: 'not-a-real-abi',
						genericArity: 'banana',
					} as never,
				],
			}),
		]);
		assert.deepStrictEqual(paths(errors).sort(), [
			'x-blocks-native-bindings.bindings["f1"].export',
			'x-blocks-native-bindings.bindings["f1"].genericArity',
		]);
	});

	it('collects instead of throwing when the thrown value has a throwing name getter', () => {
		class Hostile extends Error {
			get name(): string {
				throw new Error('name getter exploded');
			}
		}
		const hostile: Record<string, unknown> = { identity: 'p' };
		Object.defineProperty(hostile, 'platforms', {
			get() {
				throw new Hostile('x');
			},
			enumerable: true,
		});
		const errors = validateNativeCatalogs([{ sourcePackage: '@example/bb-iot', packages: [hostile] }] as never, []);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-packages']);
		assert.ok(!errors[0].message.includes('name getter exploded'), 'must not echo the thrown message');
	});

	it('rejects an unknown platform key', () => {
		const errors = validateNativeCatalogs([
			{
				sourcePackage: '@example/bb-iot',
				packages: [{ identity: 'p', platforms: { ios: DART } as never }],
			},
		]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-packages.packages["p"].platforms.ios']);
		assert.match(errors[0].message, /expected one of dart, swift, android/);
	});

	it('rejects a delivery object, which schema 1 does not define', () => {
		const errors = validateNativeCatalogs([
			{
				sourcePackage: '@example/bb-iot',
				packages: [
					{
						identity: 'p',
						platforms: { dart: { ...DART, delivery: { kind: 'npm' } } as never },
					},
				],
			},
		]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-packages.packages["p"].platforms.dart.delivery']);
		assert.match(errors[0].message, /schema 1 platform entries hold only "package"/);
	});

	it('rejects a version inside a package object with a message that explains why', () => {
		const errors = validateNativeCatalogs([
			{
				sourcePackage: '@example/bb-iot',
				packages: [
					{
						identity: 'p',
						platforms: { dart: { package: { ...DART.package, version: '1.2.3' } } as never },
					},
				],
			},
		]);
		assert.deepStrictEqual(paths(errors), [
			'x-blocks-native-packages.packages["p"].platforms.dart.package.version',
		]);
		assert.match(errors[0].message, /carries no version/);
	});

	it('reports each missing required field per platform', () => {
		const errors = validateNativeCatalogs([
			{
				sourcePackage: '@example/bb-iot',
				packages: [
					{
						identity: 'p',
						platforms: {
							dart: { package: {} as never },
							swift: { package: {} as never },
							android: { package: {} as never },
						},
					},
				],
			},
		]);
		assert.deepStrictEqual(paths(errors), [
			'x-blocks-native-packages.packages["p"].platforms.dart.package.name',
			'x-blocks-native-packages.packages["p"].platforms.dart.package.library',
			'x-blocks-native-packages.packages["p"].platforms.swift.package.identity',
			'x-blocks-native-packages.packages["p"].platforms.swift.package.product',
			'x-blocks-native-packages.packages["p"].platforms.swift.package.module',
			'x-blocks-native-packages.packages["p"].platforms.android.package.group',
			'x-blocks-native-packages.packages["p"].platforms.android.package.artifact',
			'x-blocks-native-packages.packages["p"].platforms.android.package.kotlinPackage',
		]);
	});

	it('rejects an unknown factory ABI', () => {
		const errors = validateNativeCatalogs([source({ bindings: [binding({ abi: 'blocks-transferable-v2' })] })]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-bindings.bindings["example-device-link"].abi']);
		assert.match(errors[0].message, /Unknown factory ABI/);
	});

	it('rejects a binding with an empty id, falling back to a positional path', () => {
		const errors = validateNativeCatalogs([source({ bindings: [binding({ id: '' })] })]);
		assert.deepStrictEqual(paths(errors), ['x-blocks-native-bindings.bindings[0].id']);
	});

	it('rejects empty required binding strings', () => {
		const errors = validateNativeCatalogs([source({ bindings: [binding({ export: '', tag: '', abi: '' })] })]);
		assert.deepStrictEqual(paths(errors).sort(), [
			'x-blocks-native-bindings.bindings["example-device-link"].abi',
			'x-blocks-native-bindings.bindings["example-device-link"].export',
			'x-blocks-native-bindings.bindings["example-device-link"].tag',
		]);
	});

	it('collects every error rather than stopping at the first', () => {
		const errors = validateNativeCatalogs([
			source({
				packages: [{ identity: 'example-iot-native', platforms: { dart: { package: {} as never } } }],
				bindings: [binding({ package: 'missing', abi: 'nope', tag: 'realtime/channel' })],
			}),
		]);
		assert.ok(errors.length >= 5, `expected several errors, got ${errors.length}`);
	});
});
