// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ApiNamespace } from '../api.js';
import { generateSpec, writeSpec } from './generate-spec.js';
import {
	NATIVE_BINDINGS_EXTENSION,
	NATIVE_PACKAGES_EXTENSION,
	type NativeBindingRegistration,
	NativeCatalogError,
	type NativeDeclarationSource,
} from './native-catalogs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const builtApiUrl = pathToFileURL(join(__dirname, '..', 'api.js')).href;

const TAG = 'example-iot/device-link';

function writeTsconfig(dir: string): void {
	writeFileSync(
		join(dir, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'ESNext',
				module: 'ESNext',
				moduleResolution: 'bundler',
				allowJs: true,
				esModuleInterop: true,
				skipLibCheck: true,
			},
		}),
	);
}

async function withJsBackend<T>(label: string, body: (foundationPath: string, dir: string) => Promise<T>): Promise<T> {
	const dir = join(tmpdir(), `blocks-native-catalogs-${Date.now()}-${label}`);
	try {
		mkdirSync(dir, { recursive: true });
		writeTsconfig(dir);
		writeFileSync(
			join(dir, 'index.js'),
			`
			import { ApiNamespace } from ${JSON.stringify(builtApiUrl)};

			export const api = new ApiNamespace(null, 'api', (context) => ({
				async ping() { return { ok: true }; },
			}));
			`,
		);
		return await body(join(dir, 'index.js'), dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Type extraction reads the `.ts` from disk, so the loader only has to
 * return the marker.
 */
async function withTransferableBackend<T>(label: string, body: (foundationPath: string) => Promise<T>): Promise<T> {
	const dir = join(tmpdir(), `blocks-native-catalogs-${Date.now()}-${label}`);
	try {
		mkdirSync(dir, { recursive: true });
		writeTsconfig(dir);
		writeFileSync(
			join(dir, 'index.ts'),
			`
		declare const ApiNamespace: new (
			scope: unknown,
			name: string,
			handler: (context: unknown) => Record<string, (...args: never[]) => unknown>,
		) => never;

		interface Telemetry {
			celsius: number;
		}

		interface DeviceLink<T> {
			read(): Promise<T>;
			toJSON(): { __blocks: '${TAG}' };
		}

		export const api = new ApiNamespace(null, 'api', (context: unknown) => ({
			async connectDevice(deviceId: string): Promise<DeviceLink<Telemetry>> {
				return null as unknown as DeviceLink<Telemetry>;
			},
		}));
		`,
		);
		return await body(join(dir, 'index.ts'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function stubTransferableLoader() {
	const api = new (
		ApiNamespace as unknown as new (
			scope: unknown,
			name: string,
			handler: (context: unknown) => Record<string, unknown>,
		) => unknown
	)(null, 'api', () => ({
		async connectDevice(_deviceId: string) {
			return null;
		},
	}));
	return async () => ({ api }) as Record<string, unknown>;
}

type IotDeclarations = [NativeDeclarationSource & { bindings: NativeBindingRegistration[] }];

function iotDeclarations(genericArity: number): IotDeclarations {
	return [
		{
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
					tag: TAG,
					package: 'example-iot-native',
					export: 'deviceLink',
					abi: 'blocks-transferable-v1',
					genericArity,
				},
			],
		},
	];
}

describe('generateSpec — native catalogs', () => {
	it('omits both extensions when no block declares anything', async () => {
		await withJsBackend('none', async (foundationPath) => {
			const doc = await generateSpec(foundationPath);
			assert.ok(!(NATIVE_PACKAGES_EXTENSION in doc), 'package catalog must be absent');
			assert.ok(!(NATIVE_BINDINGS_EXTENSION in doc), 'binding catalog must be absent');
		});
	});

	it('produces a byte-identical document whether or not an empty declaration list is passed', async () => {
		await withJsBackend('identical', async (foundationPath) => {
			const withoutArg = await generateSpec(foundationPath);
			const withEmptyArg = await generateSpec(foundationPath, undefined, { nativeDeclarations: [] });
			assert.strictEqual(JSON.stringify(withEmptyArg), JSON.stringify(withoutArg));
		});
	});

	it('omits both extensions when a block declares no packages and no bindings', async () => {
		await withJsBackend('empty-source', async (foundationPath) => {
			const doc = await generateSpec(foundationPath, undefined, {
				nativeDeclarations: [{ sourcePackage: '@example/bb-iot' }],
			});
			assert.ok(!(NATIVE_PACKAGES_EXTENSION in doc));
			assert.ok(!(NATIVE_BINDINGS_EXTENSION in doc));
		});
	});

	it('attaches both catalogs at the document root', async () => {
		await withJsBackend('attach', async (foundationPath) => {
			const doc = await generateSpec(foundationPath, undefined, { nativeDeclarations: iotDeclarations(1) });
			const packages = (doc as Record<string, any>)[NATIVE_PACKAGES_EXTENSION];
			const bindings = (doc as Record<string, any>)[NATIVE_BINDINGS_EXTENSION];

			assert.strictEqual(packages.schemaVersion, 1);
			assert.strictEqual(bindings.schemaVersion, 1);
			assert.ok(packages.packages['example-iot-native'].platforms.dart);
			assert.strictEqual(bindings.bindings[0].tag, TAG);
			assert.deepStrictEqual(
				doc.methods.map((m) => m.name),
				['api.ping'],
			);
		});
	});

	it('leaves method results untouched — they join a binding only by tag', async () => {
		await withTransferableBackend('join', async (foundationPath) => {
			const loader = stubTransferableLoader();
			const bare = await generateSpec(foundationPath, loader);
			const bound = await generateSpec(foundationPath, loader, { nativeDeclarations: iotDeclarations(1) });
			assert.deepStrictEqual(bound.methods, bare.methods, 'a binding must not rewrite the method');

			const schema = bound.methods[0].result.schema as Record<string, unknown>;
			assert.strictEqual(schema['x-blocks-transferable'], TAG);
			assert.strictEqual((schema['x-blocks-type-args'] as unknown[]).length, 1);
		});
	});

	it('accepts arity 1 against a real generic transferable result', async () => {
		await withTransferableBackend('arity-ok', async (foundationPath) => {
			const doc = await generateSpec(foundationPath, stubTransferableLoader(), {
				nativeDeclarations: iotDeclarations(1),
			});
			const bindings = (doc as Record<string, any>)[NATIVE_BINDINGS_EXTENSION];
			assert.strictEqual(bindings.bindings[0].genericArity, 1);
			const schema = doc.methods[0].result.schema as Record<string, unknown>;
			assert.strictEqual((schema['x-blocks-type-args'] as unknown[]).length, 1);
		});
	});

	it('rejects arity 0 against a real generic transferable result', async () => {
		await withTransferableBackend('arity-bad', async (foundationPath) => {
			await assert.rejects(
				() =>
					generateSpec(foundationPath, stubTransferableLoader(), { nativeDeclarations: iotDeclarations(0) }),
				(err: unknown) => {
					assert.ok(err instanceof NativeCatalogError);
					assert.strictEqual(err.errors.length, 1);
					assert.strictEqual(
						err.errors[0].path,
						'methods["api.connectDevice"].result.schema.x-blocks-type-args',
					);
					return true;
				},
			);
		});
	});

	it('throws a NativeCatalogError carrying every error', async () => {
		await withJsBackend('throws', async (foundationPath) => {
			const declarations = iotDeclarations(0);
			declarations[0].bindings = [
				{
					id: 'bad',
					kind: 'transferable',
					tag: 'realtime/channel',
					package: 'not-registered',
					export: 'x',
					abi: 'blocks-transferable-v9',
					genericArity: 0,
				},
			];
			await assert.rejects(
				() => generateSpec(foundationPath, undefined, { nativeDeclarations: declarations }),
				(err: unknown) => {
					assert.ok(err instanceof NativeCatalogError);
					assert.strictEqual(err.name, 'NativeCatalogError');
					assert.strictEqual(err.errors.length, 3, 'unknown ABI, unregistered package, built-in tag');
					assert.match(err.message, /Native binding metadata is invalid \(3 error\(s\)\)/);
					return true;
				},
			);
		});
	});
});

describe('writeSpec — native catalogs', () => {
	it('writes the catalogs into blocks.spec.json', async () => {
		await withJsBackend('write-ok', async (foundationPath, dir) => {
			const outputPath = join(dir, 'out', 'blocks.spec.json');
			await writeSpec(foundationPath, outputPath, undefined, { nativeDeclarations: iotDeclarations(1) });

			const written = JSON.parse(readFileSync(outputPath, 'utf-8'));
			assert.strictEqual(written[NATIVE_PACKAGES_EXTENSION].schemaVersion, 1);
			assert.strictEqual(written[NATIVE_BINDINGS_EXTENSION].bindings[0].id, 'example-device-link');
		});
	});

	it('writes nothing when metadata is invalid — the error precedes any mutation', async () => {
		await withJsBackend('write-fail', async (foundationPath, dir) => {
			const outputPath = join(dir, 'out', 'blocks.spec.json');
			const declarations = iotDeclarations(1);
			declarations[0].bindings[0].package = 'not-registered';

			await assert.rejects(
				() => writeSpec(foundationPath, outputPath, undefined, { nativeDeclarations: declarations }),
				NativeCatalogError,
			);
			assert.ok(!existsSync(outputPath), 'no spec file may be written');
			assert.ok(!existsSync(dirname(outputPath)), 'not even the output directory may be created');
		});
	});

	it('does not overwrite an existing spec when metadata is invalid', async () => {
		await withJsBackend('write-preserve', async (foundationPath, dir) => {
			const outputPath = join(dir, 'blocks.spec.json');
			writeFileSync(outputPath, '{"openrpc":"1.3.2","previous":true}');

			const declarations = iotDeclarations(1);
			declarations[0].bindings[0].package = 'not-registered';

			await assert.rejects(
				() => writeSpec(foundationPath, outputPath, undefined, { nativeDeclarations: declarations }),
				NativeCatalogError,
			);
			assert.deepStrictEqual(JSON.parse(readFileSync(outputPath, 'utf-8')), {
				openrpc: '1.3.2',
				previous: true,
			});
		});
	});
});
