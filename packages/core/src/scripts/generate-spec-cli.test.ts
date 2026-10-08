// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for the `blocks-generate-spec` bin.
 *
 * The "tsx missing" branch is covered by manual review — it's hard to
 * simulate inside this monorepo where `tsx` is hoisted at the workspace root.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, 'generate-spec-cli.js');

function makeBackend(dir: string, ext: 'ts' | 'js'): string {
	// Copy the marker module next to the foundation so a relative import
	// resolves through both ESM and CJS loaders.
	const distDir = join(__dirname, '..');
	copyFileSync(join(distDir, 'api.js'), join(dir, 'api.js'));

	const indexPath = join(dir, `index.${ext}`);
	writeFileSync(
		indexPath,
		`
		import { ApiNamespace } from './api.js';

		export const api = new ApiNamespace(null, 'api', (context) => ({
			async ping() { return { ok: true }; },
			async echo(s) { return s; },
		}));
	`,
	);
	// tsconfig that allows JS so the spec emitter's TypeScript pass succeeds
	// regardless of which extension the entry point uses.
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
	return indexPath;
}

function installBlock(dir: string, native: Record<string, unknown>): void {
	const blockDir = join(dir, 'node_modules', '@example', 'bb-iot');
	mkdirSync(blockDir, { recursive: true });
	writeFileSync(
		join(blockDir, 'package.json'),
		JSON.stringify({ name: '@example/bb-iot', version: '1.0.0', 'aws-blocks': { native } }),
	);
}

/**
 * Identities and binding ids a package installed above `tmpdir()` contributes to
 * every fixture, since the bin's walk climbs to the filesystem root. Subtracting
 * them keeps the exact-catalog assertions about the fixture, not about the host.
 */
const ambient = { packages: new Set<string>(), bindings: new Set<string>() };

before(() => {
	const dir = join(tmpdir(), `blocks-spec-cli-test-${Date.now()}-ambient`);
	mkdirSync(dir, { recursive: true });
	const outputPath = join(dir, 'blocks.spec.json');
	try {
		const result = runCli([makeBackend(dir, 'js'), outputPath]);
		assert.strictEqual(
			existsSync(outputPath),
			true,
			`the ambient probe must emit a spec or subtraction is a silent no-op.\nstderr:\n${result.stderr}`,
		);
		const spec = JSON.parse(readFileSync(outputPath, 'utf-8'));
		for (const id of Object.keys(spec['x-blocks-native-packages']?.packages ?? {})) ambient.packages.add(id);
		for (const b of spec['x-blocks-native-bindings']?.bindings ?? []) ambient.bindings.add(b.id);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function fixtureCatalogs(spec: Record<string, { packages?: Record<string, unknown>; bindings?: { id: string }[] }>) {
	const packages = spec['x-blocks-native-packages'];
	const bindings = spec['x-blocks-native-bindings'];
	return {
		packages: packages && {
			...packages,
			packages: Object.fromEntries(
				Object.entries(packages.packages ?? {}).filter(([id]) => !ambient.packages.has(id)),
			),
		},
		bindings: bindings && {
			...bindings,
			bindings: (bindings.bindings ?? []).filter((b) => !ambient.bindings.has(b.id)),
		},
	};
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
	return spawnSync(process.execPath, [cliPath, ...args], {
		encoding: 'utf-8',
		env,
	});
}

describe('blocks-generate-spec CLI', () => {
	it('accepts a TypeScript entry point and emits a valid spec', async () => {
		const dir = join(tmpdir(), `blocks-spec-cli-test-${Date.now()}-ts`);
		mkdirSync(dir, { recursive: true });
		const indexPath = makeBackend(dir, 'ts');
		const outputPath = join(dir, 'blocks.spec.json');

		try {
			const result = runCli([indexPath, outputPath]);
			assert.strictEqual(
				result.status,
				0,
				`CLI exited ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
			);
			assert.ok(existsSync(outputPath), 'spec file should exist');
			const spec = JSON.parse(readFileSync(outputPath, 'utf-8'));
			const methodNames = (spec.methods as { name: string }[]).map((m) => m.name).sort();
			assert.deepStrictEqual(methodNames, ['api.echo', 'api.ping']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('accepts a JavaScript entry point (no tsx needed)', async () => {
		const dir = join(tmpdir(), `blocks-spec-cli-test-${Date.now()}-js`);
		mkdirSync(dir, { recursive: true });
		const indexPath = makeBackend(dir, 'js');
		const outputPath = join(dir, 'blocks.spec.json');

		try {
			const result = runCli([indexPath, outputPath]);
			assert.strictEqual(
				result.status,
				0,
				`CLI exited ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
			);
			const spec = JSON.parse(readFileSync(outputPath, 'utf-8'));
			const methodNames = (spec.methods as { name: string }[]).map((m) => m.name).sort();
			assert.deepStrictEqual(methodNames, ['api.echo', 'api.ping']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('emits the native catalogs declared by an installed block', async () => {
		const dir = join(tmpdir(), `blocks-spec-cli-test-${Date.now()}-native`);
		mkdirSync(dir, { recursive: true });
		const indexPath = makeBackend(dir, 'js');
		const outputPath = join(dir, 'blocks.spec.json');
		installBlock(dir, {
			packages: [
				{
					identity: 'example-iot-native',
					platforms: {
						dart: { package: { name: 'example_iot_native', library: 'example_iot_native.dart' } },
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
					genericArity: 0,
				},
			],
		});

		try {
			const result = runCli([indexPath, outputPath]);
			assert.strictEqual(
				result.status,
				0,
				`CLI exited ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
			);
			const catalogs = fixtureCatalogs(JSON.parse(readFileSync(outputPath, 'utf-8')));
			assert.deepStrictEqual(catalogs.packages, {
				schemaVersion: 1,
				packages: {
					'example-iot-native': {
						platforms: {
							dart: { package: { name: 'example_iot_native', library: 'example_iot_native.dart' } },
						},
					},
				},
			});
			assert.deepStrictEqual(catalogs.bindings, {
				schemaVersion: 1,
				bindings: [
					{
						id: 'example-device-link',
						kind: 'transferable',
						tag: 'example-iot/device-link',
						package: 'example-iot-native',
						export: 'deviceLink',
						abi: 'blocks-transferable-v1',
						genericArity: 0,
					},
				],
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('fails without writing a spec when an installed block names an unregistered package', async () => {
		const dir = join(tmpdir(), `blocks-spec-cli-test-${Date.now()}-native-invalid`);
		mkdirSync(dir, { recursive: true });
		const indexPath = makeBackend(dir, 'js');
		const outputPath = join(dir, 'blocks.spec.json');
		installBlock(dir, {
			bindings: [
				{
					id: 'example-device-link',
					kind: 'transferable',
					tag: 'example-iot/device-link',
					package: 'never-registered',
					export: 'deviceLink',
					abi: 'blocks-transferable-v1',
					genericArity: 0,
				},
			],
		});

		try {
			const result = runCli([indexPath, outputPath]);
			assert.strictEqual(result.status, 1, `expected a non-zero exit.\nstdout:\n${result.stdout}`);
			assert.match(result.stderr, /x-blocks-native-bindings\.bindings\["example-device-link"\]\.package/);
			assert.match(result.stderr, /names package "never-registered"/);
			assert.match(result.stderr, /\(declared by @example\/bb-iot\)/);
			assert.strictEqual(existsSync(outputPath), false, 'no spec should be written');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
