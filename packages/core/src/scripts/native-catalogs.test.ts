// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
	BUILTIN_TRANSFERABLE_TAGS,
	buildNativeCatalogs,
	canonicalJson,
	type DartNativePackage,
	isPlainObject,
	KNOWN_TRANSFERABLE_ABIS,
	MAX_GENERIC_ARITY,
	NATIVE_BINDINGS_EXTENSION,
	NATIVE_CATALOG_SCHEMA_VERSION,
	NATIVE_PACKAGES_EXTENSION,
	NATIVE_PLATFORMS,
	type NativeDeclarationSource,
	type NativePlatformEntry,
} from './native-catalogs.js';

/** One block's declarations; arity 1 makes a generic binding the default. */
function iotSource(overrides: Partial<NativeDeclarationSource> = {}): NativeDeclarationSource {
	return {
		sourcePackage: '@example/bb-iot',
		packages: [
			{
				identity: 'example-iot-native',
				platforms: {
					dart: { package: { name: 'example_iot_native', library: 'example_iot_native.dart' } },
					swift: {
						package: {
							identity: 'example-iot-native',
							product: 'ExampleIotNative',
							module: 'ExampleIotNative',
						},
					},
					android: {
						package: {
							group: 'com.example.blocks',
							artifact: 'iot-native',
							kotlinPackage: 'com.example.blocks.iot',
						},
					},
				},
			},
		],
		bindings: [
			{
				id: 'example-device-link',
				kind: 'transferable',
				tag: 'example-iot/device-link',
				package: 'example-iot-native',
				export: 'deviceLink',
				abi: 'blocks-transferable-v1',
				genericArity: 1,
			},
		],
		...overrides,
	};
}

describe('buildNativeCatalogs', () => {
	it('returns null when nothing is declared, so the spec is unchanged', () => {
		assert.strictEqual(buildNativeCatalogs([]), null);
		assert.strictEqual(buildNativeCatalogs([{ sourcePackage: '@example/bb-iot' }]), null);
		assert.strictEqual(
			buildNativeCatalogs([{ sourcePackage: '@example/bb-iot', packages: [], bindings: [] }]),
			null,
		);
	});

	it('emits both catalogs with the documented shape', () => {
		const catalogs = buildNativeCatalogs([iotSource()]);
		assert.ok(catalogs);

		assert.deepStrictEqual(catalogs[NATIVE_PACKAGES_EXTENSION], {
			schemaVersion: 1,
			packages: {
				'example-iot-native': {
					platforms: {
						dart: { package: { name: 'example_iot_native', library: 'example_iot_native.dart' } },
						swift: {
							package: {
								identity: 'example-iot-native',
								product: 'ExampleIotNative',
								module: 'ExampleIotNative',
							},
						},
						android: {
							package: {
								group: 'com.example.blocks',
								artifact: 'iot-native',
								kotlinPackage: 'com.example.blocks.iot',
							},
						},
					},
				},
			},
		});

		assert.deepStrictEqual(catalogs[NATIVE_BINDINGS_EXTENSION], {
			schemaVersion: 1,
			bindings: [
				{
					id: 'example-device-link',
					kind: 'transferable',
					tag: 'example-iot/device-link',
					package: 'example-iot-native',
					export: 'deviceLink',
					abi: 'blocks-transferable-v1',
					genericArity: 1,
				},
			],
		});
	});

	it('nests platforms under "platforms", not directly on the package entry', () => {
		const catalogs = buildNativeCatalogs([iotSource()]);
		const entry = catalogs?.[NATIVE_PACKAGES_EXTENSION]?.packages['example-iot-native'] as Record<string, unknown>;
		assert.ok('platforms' in entry, 'package entry must hold a "platforms" object');
		assert.ok(!('dart' in entry), 'platforms must not be hoisted onto the package entry');
	});

	it('keeps the package object free of a version even when one is declared', () => {
		// Second line of defense: validation already rejects a stray version.
		const source = iotSource();
		(source.packages?.[0].platforms.dart?.package as unknown as Record<string, unknown>).version = '1.2.3';

		const catalogs = buildNativeCatalogs([source]);
		const dart = catalogs?.[NATIVE_PACKAGES_EXTENSION]?.packages['example-iot-native'].platforms.dart?.package;
		assert.deepStrictEqual(Object.keys(dart ?? {}), ['name', 'library']);
	});

	it('orders packages by identity and bindings by id for stable output', () => {
		const sources: NativeDeclarationSource[] = [
			{
				sourcePackage: '@example/bb-z',
				packages: [{ identity: 'z-native', platforms: {} }],
				bindings: [
					{
						id: 'z-binding',
						kind: 'transferable',
						tag: 'z/thing',
						package: 'z-native',
						export: 'zThing',
						abi: 'blocks-transferable-v1',
						genericArity: 0,
					},
				],
			},
			{
				sourcePackage: '@example/bb-a',
				packages: [{ identity: 'a-native', platforms: {} }],
				bindings: [
					{
						id: 'a-binding',
						kind: 'transferable',
						tag: 'a/thing',
						package: 'a-native',
						export: 'aThing',
						abi: 'blocks-transferable-v1',
						genericArity: 0,
					},
				],
			},
		];

		const catalogs = buildNativeCatalogs(sources);
		assert.deepStrictEqual(Object.keys(catalogs?.[NATIVE_PACKAGES_EXTENSION]?.packages ?? {}), [
			'a-native',
			'z-native',
		]);
		assert.deepStrictEqual(
			catalogs?.[NATIVE_BINDINGS_EXTENSION]?.bindings.map((b) => b.id),
			['a-binding', 'z-binding'],
		);
	});

	it('emits platforms in a fixed order regardless of declaration order', () => {
		const catalogs = buildNativeCatalogs([
			{
				sourcePackage: '@example/bb-iot',
				packages: [
					{
						identity: 'p',
						platforms: {
							android: {
								package: { group: 'g', artifact: 'a', kotlinPackage: 'k' },
							},
							dart: { package: { name: 'n', library: 'l.dart' } },
						},
					},
				],
			},
		]);
		assert.deepStrictEqual(Object.keys(catalogs?.[NATIVE_PACKAGES_EXTENSION]?.packages.p.platforms ?? {}), [
			'dart',
			'android',
		]);
	});

	it('emits one entry for an identity declared by two blocks, keeping the first', () => {
		const first = iotSource({ sourcePackage: '@example/bb-iot' });
		const second = iotSource({ sourcePackage: '@example/bb-iot-extra' });
		second.bindings = [];
		(second.packages?.[0].platforms.dart as NativePlatformEntry<DartNativePackage>).package = {
			name: 'second_wins',
			library: 'second_wins.dart',
		};

		const catalogs = buildNativeCatalogs([first, second]);
		const packages = catalogs?.[NATIVE_PACKAGES_EXTENSION]?.packages ?? {};
		assert.deepStrictEqual(Object.keys(packages), ['example-iot-native']);
		assert.strictEqual(packages['example-iot-native'].platforms.dart?.package.name, 'example_iot_native');
	});

	it('keeps an identity that collides with an Object.prototype key', () => {
		const catalogs = buildNativeCatalogs([
			{
				sourcePackage: '@example/bb-iot',
				packages: [
					{ identity: '__proto__', platforms: { dart: { package: { name: 'n', library: 'l.dart' } } } },
					{ identity: 'real-one', platforms: { dart: { package: { name: 'n2', library: 'l2.dart' } } } },
				],
			},
		]);
		const emitted = catalogs?.[NATIVE_PACKAGES_EXTENSION]?.packages ?? {};
		assert.deepStrictEqual(Object.keys(emitted).sort(), ['__proto__', 'real-one']);
		assert.strictEqual(Object.getPrototypeOf(emitted), Object.prototype, 'must not be a prototype write');
		const roundTripped = JSON.parse(JSON.stringify(catalogs));
		assert.ok('__proto__' in roundTripped[NATIVE_PACKAGES_EXTENSION].packages);
	});

	it('emits only the package catalog when a block declares no binding', () => {
		const source = iotSource();
		source.bindings = [];
		const catalogs = buildNativeCatalogs([source]);
		assert.ok(catalogs?.[NATIVE_PACKAGES_EXTENSION]);
		assert.strictEqual(
			NATIVE_BINDINGS_EXTENSION in (catalogs ?? {}),
			false,
			'an empty bindings array would read as a real, empty catalog',
		);
	});

	it('emits only the binding catalog when a block declares no package', () => {
		const source = iotSource();
		source.packages = [];
		const catalogs = buildNativeCatalogs([source]);
		assert.ok(catalogs?.[NATIVE_BINDINGS_EXTENSION]);
		assert.strictEqual(NATIVE_PACKAGES_EXTENSION in (catalogs ?? {}), false);
	});

	it('emits a binding with exactly the declared fields, in the documented order', () => {
		const source = iotSource();
		(source.bindings?.[0] as unknown as Record<string, unknown>).delivery = { kind: 'npm' };
		const catalogs = buildNativeCatalogs([source]);
		assert.deepStrictEqual(Object.keys(catalogs?.[NATIVE_BINDINGS_EXTENSION]?.bindings[0] ?? {}), [
			'id',
			'kind',
			'tag',
			'package',
			'export',
			'abi',
			'genericArity',
		]);
	});

	it('never emits the sourcePackage provenance', () => {
		const serialized = JSON.stringify(buildNativeCatalogs([iotSource()]));
		// Anchors the two negatives below: without it they also pass on `null`.
		assert.ok(serialized.includes('example-device-link'), 'expected real catalog output');
		assert.ok(!serialized.includes('sourcePackage'), 'provenance must stay out of the emitted catalogs');
		assert.ok(!serialized.includes('@example/bb-iot'), 'declaring block name must stay out of the catalogs');
	});
});

describe('isPlainObject', () => {
	it('rejects an array, a Date, and a class instance', () => {
		class Pkg {
			name = 'n';
			library = 'l.dart';
		}
		assert.strictEqual(isPlainObject([]), false);
		assert.strictEqual(isPlainObject(new Date(0)), false);
		assert.strictEqual(isPlainObject(new Pkg()), false);
	});

	it('accepts a null-prototype object, which JSON.parse can produce', () => {
		const bare = Object.create(null);
		bare.name = 'n';
		assert.strictEqual(isPlainObject(bare), true);
	});
});

describe('canonicalJson', () => {
	it('is independent of key order at every depth', () => {
		const a = { b: { y: 1, x: [{ q: 1, p: 2 }] }, a: 'z' };
		const b = { a: 'z', b: { x: [{ p: 2, q: 1 }], y: 1 } };
		assert.strictEqual(canonicalJson(a), canonicalJson(b));
	});

	it('distinguishes different values', () => {
		assert.notStrictEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
		assert.notStrictEqual(canonicalJson({ a: '1' }), canonicalJson({ a: 1 }));
	});

	it('treats an absent key and an explicit undefined as equal', () => {
		assert.strictEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 1, b: undefined }));
	});

	it('does not throw on a bigint', () => {
		assert.strictEqual(canonicalJson({ a: 1n }), '{"a":"1"}');
	});

	it('does not throw on a reference cycle', () => {
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic.self = cyclic;
		assert.strictEqual(canonicalJson(cyclic), '{"a":1,"self":"[circular]"}');
	});

	it('distinguishes a shared reference from a cycle', () => {
		const shared = { x: 1 };
		assert.strictEqual(canonicalJson({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
	});
});

describe('schema 1 constants', () => {
	it('names exactly the four built-in transferable tags', () => {
		assert.deepStrictEqual([...BUILTIN_TRANSFERABLE_TAGS].sort(), [
			'file-bucket/download',
			'file-bucket/upload',
			'oidc/client',
			'realtime/channel',
		]);
	});

	it('pins the schema version, ABI set, arity ceiling, and platform list', () => {
		assert.strictEqual(NATIVE_CATALOG_SCHEMA_VERSION, 1);
		assert.deepStrictEqual([...KNOWN_TRANSFERABLE_ABIS], ['blocks-transferable-v1']);
		assert.strictEqual(MAX_GENERIC_ARITY, 1);
		assert.deepStrictEqual([...NATIVE_PLATFORMS], ['dart', 'swift', 'android']);
	});

	it('uses the x- prefix so conforming tooling ignores both objects', () => {
		assert.ok(NATIVE_PACKAGES_EXTENSION.startsWith('x-'));
		assert.ok(NATIVE_BINDINGS_EXTENSION.startsWith('x-'));
	});
});
