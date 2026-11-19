// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateClientCode } from './generate-client.js';

/**
 * Regression test: generateClientCode collects middleware from whatever
 * the backend registers via registerClientMiddleware(). In sandbox mode,
 * the backend is imported WITHOUT --conditions=aws-runtime, so it registers
 * mock-middleware instead of aws-middleware. The dev server must NOT call
 * generateClientCode in sandbox mode (sandbox.ts already generated the
 * correct client with the aws-runtime condition).
 *
 * This test verifies the mechanism: middleware specifiers registered during
 * backend import appear as imports in the generated client code.
 */

describe('generateClientCode — middleware collection', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'blocks-gen-client-test-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('includes middleware specifiers registered by the backend', async () => {
		// Create a minimal backend that registers a middleware specifier
		const backendPath = join(tmpDir, 'backend.mjs');
		writeFileSync(
			backendPath,
			`
			globalThis.__BLOCKS_CLIENT_MIDDLEWARE__?.push('@aws-cdk-blocks/bb-realtime/aws-middleware');
		`,
		);

		const code = await generateClientCode(backendPath);
		assert.ok(
			code.includes("import '@aws-cdk-blocks/bb-realtime/aws-middleware'"),
			'Generated client must include aws-middleware when backend registers it',
		);
		assert.ok(
			!code.includes('mock-middleware'),
			'Generated client must NOT include mock-middleware when backend registers aws-middleware',
		);
	});

	it('includes mock-middleware when backend registers it (local dev mode)', async () => {
		const backendPath = join(tmpDir, 'backend.mjs');
		writeFileSync(
			backendPath,
			`
			globalThis.__BLOCKS_CLIENT_MIDDLEWARE__?.push('@aws-cdk-blocks/bb-realtime/mock-middleware');
		`,
		);

		const code = await generateClientCode(backendPath);
		assert.ok(
			code.includes("import '@aws-cdk-blocks/bb-realtime/mock-middleware'"),
			'Generated client must include mock-middleware in local dev mode',
		);
		assert.ok(
			!code.includes('aws-middleware'),
			'Generated client must NOT include aws-middleware in local dev mode',
		);
	});

	it('skips secret()/config() markers — they are values, not API namespaces', async () => {
		// A secret()/config() marker is branded with Symbol.for('@aws-cdk-blocks/hosting.ManagedValue');
		// build one inline so the fixture needs no imports. A real export still gets a proxy.
		const backendPath = join(tmpDir, 'backend.mjs');
		writeFileSync(
			backendPath,
			`
				const BRAND = Symbol.for('@aws-cdk-blocks/hosting.ManagedValue');
				export const stripeKey = { [BRAND]: true, key: 'STRIPE_KEY', kind: 'secret' };
				export const featureFlags = { [BRAND]: true, key: 'FEATURE_FLAGS', kind: 'config' };
				export function realApi() {}
			`,
		);

		const code = await generateClientCode(backendPath);
		assert.ok(
			!code.includes("__BLOCKS_ApiNamespaceClient__('stripeKey')"),
			'a secret() marker must not become an HTTP namespace',
		);
		assert.ok(
			!code.includes("__BLOCKS_ApiNamespaceClient__('featureFlags')"),
			'a config() marker must not become an HTTP namespace',
		);
		assert.ok(
			code.includes("export const realApi = __BLOCKS_ApiNamespaceClient__('realApi')"),
			'a real (non-marker) export still becomes a namespace',
		);
	});

	it('skips server-only functions, however they were copied out (auth.admin methods)', async () => {
		// The fixture registers its "admin" methods through the dispatcher's own
		// markServerOnlyFunction, imported by file URL so it needs no package resolution
		// from the temp dir. It mirrors what bb-auth does for `auth.admin`.
		const rpcDispatch = pathToFileURL(join(import.meta.dirname, '..', 'rpc-dispatch.js')).href;
		const backendPath = join(tmpDir, 'backend.mjs');
		writeFileSync(
			backendPath,
			`
				import { markServerOnlyFunction } from '${rpcDispatch}';
				const admin = { async deleteUser() {}, async addUserToGroup() {} };
				for (const fn of Object.values(admin)) markServerOnlyFunction(fn);
				const auth = { admin };
				export const { deleteUser } = auth.admin;
				export const remove = auth.admin.deleteUser;
				export function realApi() {}
			`,
		);

		const code = await generateClientCode(backendPath);
		assert.ok(!code.includes("'deleteUser'"), 'a destructured admin method must not get a client proxy');
		assert.ok(!code.includes("'remove'"), 'a renamed admin method must not get a client proxy');
		assert.ok(
			code.includes("export const realApi = __BLOCKS_ApiNamespaceClient__('realApi')"),
			'an ordinary exported function still gets a client proxy',
		);
	});
});

describe('generateClientCode — generateClient options', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'blocks-gen-client-opts-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('passes the options object unchanged to every namespace client (url, retryStaleConnection)', async () => {
		const backendPath = join(tmpDir, 'backend.mjs');
		writeFileSync(backendPath, 'export function api() {}\nexport function other() {}\n');
		const code = await generateClientCode(backendPath);

		// Run the generated module against a stub ApiNamespaceClient that records its arguments.
		const stubPath = join(tmpDir, 'stub-client.mjs');
		writeFileSync(
			stubPath,
			'export const calls = [];\nexport function ApiNamespaceClient(name, options) { calls.push({ name, options }); return { name }; }\n',
		);
		const stubUrl = pathToFileURL(stubPath).href;
		const clientPath = join(tmpDir, 'client.mjs');
		const specifier = "'aws-cdk-blocks/client'";
		assert.ok(
			code.includes(specifier),
			'generated client imports ApiNamespaceClient from aws-cdk-blocks/client',
		);
		writeFileSync(clientPath, code.replace(specifier, `'${stubUrl}'`));

		const client = (await import(pathToFileURL(clientPath).href)) as {
			generateClient: (config: unknown) => Record<string, unknown>;
		};
		const stub = (await import(stubUrl)) as { calls: { name: string; options: unknown }[] };
		stub.calls.length = 0; // drop the module-level default exports' calls

		const config = { url: 'http://127.0.0.1:1/cdk-blocks/api', retryStaleConnection: false };
		const generated = client.generateClient(config);
		assert.deepStrictEqual(Object.keys(generated).sort(), ['api', 'other']);
		assert.deepStrictEqual(stub.calls.map((c) => c.name).sort(), ['api', 'other']);
		for (const call of stub.calls) {
			assert.strictEqual(call.options, config, `${call.name} must receive the generateClient options as is`);
		}
	});
});
