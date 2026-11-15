// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type DocsIndex, type DocsRequest, loadDocs, parseSections, renderDocs } from './docs.js';
import { CliError, ExitCode } from './errors.js';
import { runCli } from './test-helpers.js';

const FILES: Record<string, string> = {
	'README.md': [
		'# AWS Blocks',
		'<!-- BEGIN:block-catalog -->',
		'| Block | What it does | Keywords |',
		'|-------|--------------|----------|',
		'| bb-distributed-table | Tables with indexes. | — |',
		'| bb-kv-store | Values by key. | — |',
		'| core | The framework core. | — |',
		'<!-- END:block-catalog -->',
	].join('\n'),
	'API.md': [
		'```ts',
		"import { KVStore } from '@aws-blocks/bb-kv-store';",
		"import { PutOptions as DTPutOptions } from '@aws-blocks/bb-distributed-table';",
		"import { PutOptions as KVPutOptions } from '@aws-blocks/bb-kv-store';",
		'export { DTPutOptions }',
		'',
		'export { KVPutOptions }',
		'',
		'export { KVStore }',
		'',
		'export * from "@aws-blocks/core";',
		'',
		'// @public',
		'export function getSdkIdentifiers(bb: KVStore<any>): {',
		'    tableName: string;',
		'};',
		'',
		'// @public (undocumented)',
		'export function getSdkIdentifiers(bb: DistributedTable<any, any, any>): {',
		'    tableName: string;',
		'};',
		'```',
	].join('\n'),
	'TROUBLESHOOTING.md': '# Troubleshooting\n\n## Port in use\nStop the other server.\n',
	'core/README.md': [
		'# core',
		'',
		'## Namespaces',
		'Export an ApiNamespace.',
		'',
		'```ts',
		'# not a heading',
		'```',
		'',
		'## Errors',
		'',
		'### Throwing',
		"Throw `new ApiError('Not found', 404)`; the client gets the status.",
		'',
		'## Testing',
		'Run the tests.',
	].join('\n'),
	'core/API.md': [
		'```ts',
		"import { config } from '@aws-blocks/hosting';",
		'',
		'export { config }',
		'',
		'// @public (undocumented)',
		'export class ApiError extends Error {',
		'    constructor(message: string, status: number);',
		'    // (undocumented)',
		'    readonly status: number;',
		'}',
		'',
		'// @public',
		'export function internalHelper(): void;',
		'',
		'// @public',
		'export function _resetCache(): void;',
		'',
		'// @public',
		'export function getSdkIdentifiers(bb: unknown): Record<string, string>;',
		'```',
	].join('\n'),
	'bb-distributed-table/README.md': [
		'# DistributedTable',
		'',
		'## Queries',
		'Use an index; never scan. limit caps the page.',
		'',
		'## Conditional Operations',
		'',
		'```ts',
		'await table.put(item, { ifFieldEquals: { version: 3 } });',
		'```',
		'A failed condition throws ConditionalCheckFailed; nothing is written.',
	].join('\n'),
	'bb-distributed-table/API.md': [
		'```ts',
		'// @public (undocumented)',
		'export class DistributedTable<T> extends Scope {',
		'    put(item: T, options?: PutOptions<T>): Promise<void>;',
		'    query(options: unknown): AsyncIterable<T>;',
		'}',
		'',
		'// @public (undocumented)',
		'export type PutOptions<T> = {',
		'    ifNotExists: true;',
		'    ifFieldEquals?: never;',
		'} | {',
		'    ifNotExists?: never;',
		'    ifFieldEquals: Partial<T>;',
		'};',
		'```',
	].join('\n'),
	'bb-distributed-table/DESIGN.md': '# Design\n\nPartition keys; the limit is per partition.\n',
	// The intro and a list of methods mention get before the section that calls it.
	'bb-kv-store/README.md':
		'# KVStore\n\nValues by key: read one with get.\n\n## Usage\nget and put by key; limit is not supported.\n\n## Reading\nconst value = await store.get(key);\n',
	'bb-kv-store/API.md':
		"```ts\nimport type { StandardSchemaV1 } from '@standard-schema/spec';\n\n// @public\nexport class KVStore<T> extends Scope {\n    get(key: string): Promise<T | null>;\n}\n\n// @public\nexport function kvKeyOf(id: string): string;\n\n// @public\nexport interface PutOptions {\n    ifNotExists?: boolean;\n}\n```\n",
	// Shaped like the real AuthCognito report: longer than a card prints whole, with multi-line members and overloads.
	'bb-auth-cognito/API.md': [
		'```ts',
		'// @public (undocumented)',
		'export class AuthCognito<const O extends AuthCognitoMockOptions = AuthCognitoMockOptions> extends Scope implements BlocksAuth {',
		'    constructor(scope: ScopeParent, id: string, options?: O);',
		...Array.from({ length: 20 }, (_, i) => `    member${i}(context: BlocksContext): Promise<void>;`),
		'    setUpTOTP(context: BlocksContext): Promise<{',
		'        sharedSecret: string;',
		'    }>;',
		'    signIn(username: string, password: string, context: BlocksContext, options?: SignInOptions): Promise<SignInResult<O>>;',
		'    signOut(context: BlocksContext, options?: {',
		'        global?: boolean;',
		'    }): Promise<void>;',
		'    signUp(username: string, password: string, options?: SignUpOptions<O>): Promise<SignUpResult>;',
		'    // (undocumented)',
		'    signUp(username: string, password: string, options: SignUpOptions<O>, context: BlocksContext): Promise<SignUpResult>;',
		'}',
		'```',
	].join('\n'),
	'bb-auth-cognito/README.md': '# AuthCognito\n\n## Sign out\nsignOut ends the session.\n',
	// Shaped like bb-auth's report: Auth declares only its constructor and inherits its members from AuthBase.
	'bb-auth/API.md': [
		'```ts',
		'// @public',
		'export class Auth<const O extends AuthOptions = AuthOptions> extends AuthBase<O> {',
		'    constructor(scope: ScopeParent, id: string, options?: O);',
		'}',
		'',
		'// @public',
		'export class AuthBase<const O extends AuthOptions = AuthOptions> extends AuthRoot<O> implements AuthShape<O> {',
		'    constructor(scope: ScopeParent, id: string, options?: O);',
		'    get admin(): AdminGetterOf<O>;',
		'    protect<M extends ApiMethods>(scope: ScopeParent, name: string, handlers: ProtectHandlers<M, O>): ProtectedApi<M>;',
		'}',
		'',
		'// @public',
		'export class AuthRoot<O> extends Scope {',
		'    readonly userPoolId: string;',
		'}',
		'',
		'// @public',
		"export interface AuthShape<O extends AuthOptions = AuthOptions> extends AuthReader, Omit<AuthWriter<O>, 'dropUser'> {",
		'}',
		'',
		'// @public',
		'export interface AuthReader {',
		'    readUser(id: string): Promise<unknown>;',
		'}',
		'',
		'// @public',
		'export interface AuthWriter<O> {',
		'    dropUser(id: string): Promise<void>;',
		'    writeUser(id: string, options: O): Promise<void>;',
		'}',
		'',
		'// @public',
		'export interface LoopA extends LoopB {',
		'    loopA(): void;',
		'}',
		'',
		'// @public',
		'export interface LoopB extends LoopA {',
		'    loopB(): void;',
		'}',
		'```',
	].join('\n'),
	'bb-auth/README.md': '# Auth\n\n## Protect an API\nauth.protect(scope, name, handlers) checks the caller first.\n',
	// Shaped like bb-secret's README: "read caching" shares one word with a heading about writes.
	'bb-secret/README.md': [
		'# Secret',
		'',
		'## Read-only by default',
		'Writes need allowRuntimeWrite: true.',
		'',
		'## Usage',
		'Reads are cached: get() caches the value for 300 seconds.',
	].join('\n'),
	// Shaped like bb-secret's report: the instance type is a class the entry point does not export. The folder is not
	// `bb-vault`, which would make `Vault` name the block.
	'bb-locker/API.md': [
		'```ts',
		'// Warning: (ae-forgotten-export) The symbol "VaultImpl" needs to be exported by the entry point index.aws.d.ts',
		'//',
		'// @public',
		"export type Vault<T = string> = Omit<VaultImpl<T>, 'put'>;",
		'',
		'// @public (undocumented)',
		'export const Vault: VaultConstructor;',
		'',
		'// @public',
		'export interface VaultConstructor {',
		'    new <T = string>(scope: unknown, id: string): Vault<T>;',
		'}',
		'',
		'// @public',
		'export type WritableVault<T = string> = Vault<T> & {',
		'    put(value: T): Promise<void>;',
		'};',
		'```',
	].join('\n'),
	// The README mentions durability and depth, which CUSTOM.md has headings for.
	'bb-locker/README.md':
		'# Locker\n\n## Reading\nget() reads the value.\n\n## Writing\nput() writes a new version; durability and nesting depth are the store’s.\n',
	// A doc of the block besides its README, shaped like bb-auth's CUSTOMIZING-AUTH-UI.md.
	'bb-locker/CUSTOM.md':
		'# Custom\n\n## Depth 3: fully custom UI\nBuild your own form.\n\n## Durability & Security\nDefaults.\n',
	// Shaped like bb-realtime's report: the class is a const whose construct signature returns another interface.
	'bb-hub/API.md': [
		'```ts',
		'// @public',
		'export const Hub: {',
		'    new <T>(scope: unknown, id: string, options: { onError: (e: unknown) => void }): HubServer<T>;',
		'};',
		'',
		'// @public',
		'export interface HubServer<T> {',
		'    publish(channel: string, data: T): Promise<void>;',
		'    subscribe(channel: string, handler: (data: T) => void): () => void;',
		'}',
		'',
		'// @public',
		'export const HubErrors: {',
		'    readonly Closed: "HubClosedException";',
		'};',
		'```',
	].join('\n'),
	// Four blocks whose option types share a field, for the card's limit on blocks printed in full.
	...Object.fromEntries(
		[1, 2, 3, 4].map((i) => [
			`bb-w${i}/API.md`,
			`\`\`\`ts\nexport interface W${i}Options {\n    shared?: boolean;\n}\n\`\`\`\n`,
		]),
	),
};

const VENDORIZE = { '@aws-blocks/bb-kv-store': ['KVStore'], '@aws-blocks/bb-distributed-table': ['DistributedTable'] };

/**
 * The installed package beside its docs, shaped like the real one: package.json `exports` with subpath entries (the
 * client re-exports core's whole, core's names it re-exports in clauses; /ui's names come in a multi-line clause),
 * `/cdk` and entries without types, and a browser entry of @aws-blocks/blocks that exports nothing.
 */
const PACKAGE: Record<string, string> = {
	'package.json': JSON.stringify({
		name: '@aws-blocks/blocks',
		exports: {
			'.': { browser: './dist/index.browser.js', types: './dist/index.d.ts', default: './dist/index.js' },
			'./cdk': { types: './dist/index.cdk.d.ts', default: './dist/index.cdk.js' },
			'./client': { types: './dist/client.d.ts', default: './dist/client.js' },
			'./lambda-handler': './dist/lambda-handler.js',
			'./ui': { types: './dist/ui.d.ts', default: './dist/ui.js' },
			'./docs/*': './docs/*',
		},
	}),
	'dist/client.d.ts': "export * from './core-client.js';\n",
	'dist/core-client.js': '',
	'dist/core-client.d.ts': [
		'export type BlocksContext = any;',
		'export interface BlocksRequest {',
		'    path: string;',
		'}',
		'export declare function ApiNamespaceClient(name: string): unknown;',
		"export { ApiError, isBlocksError } from './errors.js';",
		"export { Scope, type ScopeOptions } from './common.js';",
	].join('\n'),
	'dist/index.cdk.d.ts': 'export declare function cdkOnly(): void;\n',
	'dist/index.browser.d.ts': 'export {};\n',
	// The main types entry re-exports hosting's names from an installed package, as core's does.
	'dist/index.d.ts': "export { config } from '@aws-blocks/hosting';\n",
	'node_modules/@aws-blocks/hosting/package.json': JSON.stringify({
		name: '@aws-blocks/hosting',
		exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
	}),
	'node_modules/@aws-blocks/hosting/dist/index.js': '',
	'node_modules/@aws-blocks/hosting/dist/index.d.ts': [
		'/**',
		' * Reads a config value.',
		' */',
		'export declare function config(name: string): string;',
	].join('\n'),
	'dist/ui.d.ts': "export {\n    Authenticator,\n    onAuthChange,\n    type AuthStateApi,\n} from './auth-ui.js';\n",
	// Type files are found through the JavaScript file beside them, as an import resolves.
	'dist/auth-ui.js': 'export function onAuthChange() {}\n',
	'dist/auth-ui.d.ts': [
		'export interface AuthStateApi {',
		'    getAuthState(): Promise<unknown>;',
		'}',
		'/**',
		' * Subscribe to auth changes. Calls `callback` synchronously first.',
		' *',
		' * @returns An unsubscribe function.',
		' */',
		'export declare function onAuthChange(api: AuthStateApi, callback: (user: unknown) => void): () => void;',
	].join('\n'),
	// bb-locker's installed type file: VaultImpl, imported from another file, with doc comments on its members (one
	// with unbalanced brackets in its prose) and long enough that a member card prints only that member.
	'node_modules/@aws-blocks/bb-locker/package.json': JSON.stringify({
		name: '@aws-blocks/bb-locker',
		exports: { '.': { types: './dist/index.mock.d.ts', default: './dist/index.mock.js' } },
	}),
	'node_modules/@aws-blocks/bb-locker/dist/index.mock.js': "export { VaultImpl } from './impl.js';\n",
	'node_modules/@aws-blocks/bb-locker/dist/index.mock.d.ts': [
		"import { VaultImpl } from './impl.js';",
		"export type Vault<T = string> = Omit<VaultImpl<T>, 'put'>;",
	].join('\n'),
	'node_modules/@aws-blocks/bb-locker/dist/impl.js': 'export class VaultImpl {}\n',
	'node_modules/@aws-blocks/bb-locker/dist/impl.d.ts': [
		'/**',
		' * A vault of one value.',
		' */',
		'export declare class VaultImpl<T = string> {',
		'    /**',
		'     * Reads the value: 1) the cache, 2) the store.',
		'     */',
		'    get(): Promise<T | null>;',
		...Array.from({ length: 22 }, (_, i) => `    member${i}(): void;`),
		'    /** Writes a new version. */',
		'    put(value: T): Promise<void>;',
		'}',
	].join('\n'),
	'node_modules/@aws-blocks/bb-kv-store/package.json': JSON.stringify({
		name: '@aws-blocks/bb-kv-store',
		exports: { '.': { types: './dist/index.mock.d.ts', default: './dist/index.mock.js' } },
	}),
	'node_modules/@aws-blocks/bb-kv-store/dist/index.mock.js': 'export class KVStore {}\n',
	'node_modules/@aws-blocks/bb-kv-store/dist/index.mock.d.ts': [
		'export declare class KVStore<T> extends Scope {',
		'    /**',
		'     * Reads a value; null when the key is missing.',
		'     */',
		'    get(key: string): Promise<T | null>;',
		'}',
	].join('\n'),
};

let root: string;
let dir: string;
let index: DocsIndex;

const BACKEND_ONLY =
	'(backend only: @aws-blocks/blocks/client, which browser code and tests import values from, does not export it)';
const A_TYPE = '(a type: the same import works in browser code and tests)';

function render(names: string[], options: Partial<DocsRequest> = {}): string {
	return renderDocs(index, { names, api: false, toc: false, sections: [], ...options }, '1.2.3');
}

function fails(fn: () => unknown, exitCode: number, message: RegExp): void {
	assert.throws(fn, (error: unknown) => {
		assert.ok(error instanceof CliError, String(error));
		assert.strictEqual(error.exitCode, exitCode);
		assert.match(`${error.message}\n${error.hint ?? ''}`, message);
		return true;
	});
}

before(() => {
	root = mkdtempSync(join(tmpdir(), 'blocks-docs-'));
	dir = join(root, 'docs');
	const write = (base: string, files: Record<string, string>) => {
		for (const [file, text] of Object.entries(files)) {
			mkdirSync(join(base, file, '..'), { recursive: true });
			writeFileSync(join(base, file), text);
		}
	};
	write(dir, FILES);
	write(root, PACKAGE);
	index = loadDocs(dir, VENDORIZE);
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('cdk-blocks docs <block>', () => {
	it('names a block by class, folder or short name, in any case, and prints its README under a header', () => {
		const expected = render(['bb-distributed-table']);
		assert.ok(
			expected.startsWith(
				`# bb-distributed-table/README.md (${join(dir, 'bb-distributed-table', 'README.md')})\n# DistributedTable`,
			),
		);
		for (const name of [
			'DistributedTable',
			'distributed-table',
			'distributedtable',
			'@aws-blocks/bb-distributed-table',
		]) {
			assert.strictEqual(render([name]), expected, name);
		}
	});

	it('prints several blocks in one call, each under its own header', () => {
		const out = render(['KVStore', 'core']);
		assert.match(out, /^# bb-kv-store\/README\.md \(/m);
		assert.match(out, /^# core\/README\.md \(/m);
		assert.ok(out.indexOf('# bb-kv-store/') < out.indexOf('# core/'));
	});

	it('prints the API report with --api instead of the README', () => {
		assert.match(
			render(['DistributedTable'], { api: true }),
			/^# bb-distributed-table\/API\.md \(.*\)\n```ts\n\/\/ @public/,
		);
	});

	it('reaches the framework guide and troubleshooting by name', () => {
		assert.match(render(['guide']), /^# README\.md \(/);
		assert.match(render(['guide'], { api: true }), /^# API\.md \(/);
		assert.match(render(['troubleshooting']), /^# TROUBLESHOOTING\.md \(.*\)\n# Troubleshooting/);
	});

	it('rejects an unknown name as a usage error that suggests the closest name and a search', () => {
		fails(
			() => render(['DistributedTabel']),
			ExitCode.Usage,
			/Did you mean "DistributedTable"\?[\s\S]*--search "DistributedTabel"/,
		);
	});

	it('lists the doc lines that mention an unknown name', () => {
		fails(
			() => render(['ConditionalCheckFailed']),
			ExitCode.Usage,
			/^no block, export or option named "ConditionalCheckFailed"\.\nThe docs mention it here:\nbb-distributed-table\/README\.md:11 \[conditional-operations\]: A failed condition throws ConditionalCheckFailed; nothing is written\.$/m,
		);
	});
});

describe('cdk-blocks docs <export or option>', () => {
	it('prints an export: its import, its declaration without report comments, and the section that documents it', () => {
		const out = render(['ApiError']);
		const lines = out.split('\n');
		assert.strictEqual(
			lines[0],
			"ApiError: class in @aws-blocks/core. Backend: import { ApiError } from '@aws-blocks/blocks'; Browser code and tests: import { ApiError } from '@aws-blocks/blocks/client';",
		);
		assert.match(
			out,
			/^# core\/API\.md \(.*\)\nexport class ApiError extends Error \{\n {4}constructor\(message: string, status: number\);\n {4}readonly status: number;\n\}$/m,
		);
		assert.doesNotMatch(out, /@public|\(undocumented\)/);
		assert.match(out, /^# core\/README\.md \(.*\)\n\(lines 12-14\)\n### Throwing\nThrow `new ApiError/m);
	});

	it('says when @aws-blocks/blocks does not re-export an export, and imports it from its package', () => {
		assert.match(
			render(['kvKeyOf']),
			/^kvKeyOf: function in @aws-blocks\/bb-kv-store\. import \{ kvKeyOf \} from '@aws-blocks\/bb-kv-store'; \(not re-exported by @aws-blocks\/blocks\)$/m,
		);
		assert.strictEqual(
			render(['internalHelper']).split('\n')[0],
			`internalHelper: function in @aws-blocks/core. import { internalHelper } from '@aws-blocks/blocks'; ${BACKEND_ONLY}`,
		);
	});

	it('imports a name that only a package @aws-blocks/blocks re-exports whole re-exports, or only a subpath entry has', () => {
		const imports = {
			isBlocksError: "import { isBlocksError } from '@aws-blocks/blocks/client';",
			ScopeOptions: "import type { ScopeOptions } from '@aws-blocks/blocks/client';",
		};
		for (const [exported, line] of Object.entries(imports)) {
			assert.strictEqual(
				render([exported.toLowerCase()]).split('\n')[0],
				`${exported}: export, with no declaration in the docs. Browser code and tests: ${line} (@aws-blocks/blocks itself does not export it)`,
			);
		}
		fails(() => render(['cdkOnly']), ExitCode.Usage, /no block, export or option named "cdkOnly"/);
	});

	it("prints the declaration and doc comment of an export the reports lack from the entry's type files", () => {
		// Followed from dist/index.d.ts to the installed @aws-blocks/hosting; a function, so backend only.
		const config = render(['config']).split('\n');
		assert.deepStrictEqual(config.slice(0, 7), [
			`config: function in @aws-blocks/hosting. import { config } from '@aws-blocks/blocks'; ${BACKEND_ONLY}`,
			'',
			`# @aws-blocks/hosting/dist/index.d.ts (${join(root, 'node_modules/@aws-blocks/hosting/dist/index.d.ts')})`,
			'/**',
			' * Reads a config value.',
			' */',
			'export declare function config(name: string): string;',
		]);
		assert.deepStrictEqual(config.slice(7, 9), ['', 'The docs mention it here:']);
		// Followed through /ui's multi-line `export { … } from` clause.
		const onAuthChange = render(['onAuthChange']).split('\n');
		assert.deepStrictEqual(onAuthChange.slice(0, 3), [
			"onAuthChange: function in @aws-blocks/blocks. import { onAuthChange } from '@aws-blocks/blocks/ui'; (@aws-blocks/blocks itself does not export it)",
			'',
			`# @aws-blocks/blocks/dist/auth-ui.d.ts (${join(root, 'dist/auth-ui.d.ts')})`,
		]);
		assert.match(
			onAuthChange.join('\n'),
			/^ \* Subscribe to auth changes\.[\s\S]*\nexport declare function onAuthChange\(/m,
		);
		assert.doesNotMatch(onAuthChange.join('\n'), /getAuthState/);
		// Through `export *` to a declaration in the file itself; an interface gets `import type`.
		assert.strictEqual(
			render(['BlocksRequest']).split('\n')[0],
			"BlocksRequest: interface in @aws-blocks/blocks. Browser code and tests: import type { BlocksRequest } from '@aws-blocks/blocks/client'; (@aws-blocks/blocks itself does not export it)",
		);
	});

	it('says where a name the API reports import from another package comes from', () => {
		assert.strictEqual(
			render(['StandardSchemaV1']).split('\n')[0],
			"StandardSchemaV1: from @standard-schema/spec, not an AWS Blocks package. The API reports of bb-kv-store import it: import type { StandardSchemaV1 } from '@standard-schema/spec';",
		);
	});

	it("serves the umbrella's own overloads over the same name from a package it re-exports whole", () => {
		const out = render(['getSdkIdentifiers']);
		assert.deepStrictEqual(
			out.split('\n').filter((line) => line.startsWith('getSdkIdentifiers:')),
			[
				`getSdkIdentifiers: function in @aws-blocks/blocks. import { getSdkIdentifiers } from '@aws-blocks/blocks'; ${BACKEND_ONLY}`,
			],
		);
		assert.match(
			out,
			/^# API\.md \(.*\)\nexport function getSdkIdentifiers\(bb: KVStore<any>\): \{\n {4}tableName: string;\n\};\nexport function getSdkIdentifiers\(bb: DistributedTable<any, any, any>\): \{$/m,
		);
		assert.doesNotMatch(out, /Record<string, string>|# core\/API\.md/);
	});

	it('prints the name @aws-blocks/blocks exports a declaration under, as `import type` for a type, and finds it by that name', () => {
		const original = render(['PutOptions']).split('\n');
		// Types are not backend only: `import type` is erased, and TypeScript resolves the types entry, not the
		// browser condition that `npm run test:e2e` runs under.
		assert.deepStrictEqual(original.slice(0, 2), [
			`PutOptions: type in @aws-blocks/bb-distributed-table. import type { DTPutOptions } from '@aws-blocks/blocks'; ${A_TYPE}`,
			`PutOptions: interface in @aws-blocks/bb-kv-store. import type { KVPutOptions } from '@aws-blocks/blocks'; ${A_TYPE}`,
		]);
		for (const name of ['DTPutOptions', 'dtputoptions']) {
			const out = render([name]);
			assert.ok(
				out.startsWith(
					`DTPutOptions: type PutOptions in @aws-blocks/bb-distributed-table. import type { DTPutOptions } from '@aws-blocks/blocks'; ${A_TYPE}\n`,
				),
				out,
			);
			assert.match(out, /^# bb-distributed-table\/API\.md \(.*\)\nexport type PutOptions<T> = \{$/m);
			assert.doesNotMatch(out, /bb-kv-store/);
		}
		assert.match(render(['KVPutOptions']), /^KVPutOptions: interface PutOptions in @aws-blocks\/bb-kv-store\./m);
	});

	it('finds an option by member name: the declarations that have it and the README section that uses it', () => {
		const out = render(['ifFieldEquals']);
		assert.match(out, /^ifFieldEquals: member of PutOptions \(@aws-blocks\/bb-distributed-table\)$/m);
		assert.match(out, /export type PutOptions<T> = \{\n {4}ifNotExists: true;\n {4}ifFieldEquals\?: never;/);
		assert.match(out, /^# bb-distributed-table\/README\.md \(.*\)\n\(lines 6-11\)\n## Conditional Operations/m);
	});

	it('names a block, not a card, for the class that names the block', () => {
		assert.match(render(['KVStore']), /^# bb-kv-store\/README\.md \(/);
	});

	it('reads a doc path as its block and file, and lists the names of an entry named on its own', () => {
		assert.match(render(['bb-distributed-table/DESIGN.md']), /^# bb-distributed-table\/DESIGN\.md \(/);
		// A path to a doc the block lacks fails rather than printing the README.
		fails(
			() => render(['bb-kv-store/DESIGN.md']),
			ExitCode.Failure,
			/^bb-kv-store has no DESIGN\.md\. Its files: /,
		);
		assert.match(
			render(['node_modules/@aws-blocks/blocks/docs/bb-kv-store/README.md']),
			/^# bb-kv-store\/README\.md \(/,
		);
		for (const name of ['ui', '@aws-blocks/blocks/ui']) {
			assert.strictEqual(
				render([name]),
				"@aws-blocks/blocks/ui (3 names): import { <name> } from '@aws-blocks/blocks/ui';\n  Authenticator, AuthStateApi, onAuthChange\nA name's declaration: npx --no -- cdk-blocks docs <name>\n",
			);
		}
	});

	it('lists the exports that have every word of an unknown name', () => {
		fails(() => render(['PutOptionsKV']), ExitCode.Usage, /^Exports with every word of it: KVPutOptions$/m);
	});

	it("prints the README section a member's name or its stem heads, else its first mention below the intro", () => {
		// No heading or line says "query"; "Queries" shares its stem.
		assert.match(
			render(['DistributedTable.query']),
			/^# bb-distributed-table\/README\.md \(.*\)\n\(lines 3-\d+\)\n## Queries\nUse an index; never scan\./m,
		);
		// The intro and a method list mention get first; the section that calls it is Reading, not the whole doc.
		const get = render(['KVStore.get']);
		assert.match(
			get,
			/^# bb-kv-store\/README\.md \(.*\)\n\(lines 8-\d+\)\n## Reading\nconst value = await store\.get\(key\);$/m,
		);
		// The member comes from the installed type file, with its doc comment, in place of the report's lines.
		assert.ok(
			get.includes(
				`\n# @aws-blocks/bb-kv-store/dist/index.mock.d.ts (${join(root, 'node_modules/@aws-blocks/bb-kv-store/dist/index.mock.d.ts')})\nexport declare class KVStore<T> extends Scope {\n    /**\n     * Reads a value; null when the key is missing.\n     */\n    get(key: string): Promise<T | null>;\n}\n`,
			),
			get,
		);
		assert.doesNotMatch(get, /# bb-kv-store\/API\.md/);
	});

	it("finds a constructor const's member on what its construct signature returns", () => {
		assert.strictEqual(
			render(['Hub.publish']).split('\n')[0],
			'publish: member of HubServer (what new Hub(…) returns) (@aws-blocks/bb-hub)',
		);
	});

	it('reads what a report only names (ae-forgotten-export) from the installed type file, with doc comments', () => {
		const file = join(root, 'node_modules/@aws-blocks/bb-locker/dist/impl.d.ts');
		const header = `# @aws-blocks/bb-locker/dist/impl.d.ts (${file}): VaultImpl, not exported by its package`;
		// `Vault` is the report's alias of VaultImpl, so Vault.get is VaultImpl's get, with its doc comment.
		assert.deepStrictEqual(render(['Vault.get']).split('\n').slice(0, 10), [
			'get: member of VaultImpl (the type of Vault) (@aws-blocks/bb-locker)',
			'',
			header,
			'export declare class VaultImpl<T = string> {',
			'    // ...',
			'    /**',
			'     * Reads the value: 1) the cache, 2) the store.',
			'     */',
			'    get(): Promise<T | null>;',
			'    // ...',
		]);
		// The prose's brackets do not end the class early: its last member is found.
		assert.match(
			render(['VaultImpl.put']),
			/^ {4}\/\*\* Writes a new version\. \*\/\n {4}put\(value: T\): Promise<void>;$/m,
		);
		// Vault is `Omit<VaultImpl<T>, 'put'>`: it has no put, which WritableVault adds back.
		assert.deepStrictEqual(render(['Vault.put']).split('\n').slice(0, 2), [
			"Vault leaves out put: export type Vault<T = string> = Omit<VaultImpl<T>, 'put'>;",
			'put: member of WritableVault (@aws-blocks/bb-locker)',
		]);
		// The alias's card adds what it stands for, without doc comments when that is long.
		const vault = render(['Vault']);
		assert.ok(
			vault.includes(
				`\n${header}\nexport declare class VaultImpl<T = string> {\n    get(): Promise<T | null>;\n`,
			),
			vault,
		);
		assert.strictEqual(
			render(['VaultImpl']).split('\n')[0],
			'VaultImpl: class in @aws-blocks/bb-locker, not exported: it is the type of Vault.',
		);
	});

	it('prints whole multi-line members and every overload of a long declaration, also for a nested option', () => {
		const head =
			'export class AuthCognito<const O extends AuthCognitoMockOptions = AuthCognitoMockOptions> extends Scope implements BlocksAuth {';
		const signOut = [
			'    signOut(context: BlocksContext, options?: {',
			'        global?: boolean;',
			'    }): Promise<void>;',
		];
		for (const name of ['signOut', 'global']) {
			const out = render([name]);
			assert.ok(out.includes([head, '    // ...', ...signOut, '    // ...', '}'].join('\n')), out);
			assert.doesNotMatch(out, /member0|setUpTOTP|signIn\(/);
		}
		const overloads = render(['signUp']);
		assert.ok(
			overloads.includes(
				[
					'    signUp(username: string, password: string, options?: SignUpOptions<O>): Promise<SignUpResult>;',
					'    signUp(username: string, password: string, options: SignUpOptions<O>, context: BlocksContext): Promise<SignUpResult>;',
				].join('\n'),
			),
			overloads,
		);
		assert.ok(
			render(['sharedSecret']).includes(
				'    setUpTOTP(context: BlocksContext): Promise<{\n        sharedSecret: string;\n    }>;',
			),
		);
	});

	it('looks up Owner.member as that member of that declaration only', () => {
		assert.match(
			render(['putoptions.IFFIELDEQUALS']),
			/^ifFieldEquals: member of PutOptions \(@aws-blocks\/bb-distributed-table\)$/m,
		);
		// A known owner without that member names its members, and nothing else.
		fails(
			() => render(['KVStore.ifFieldEquals']),
			ExitCode.Usage,
			/^KVStore has no member "ifFieldEquals" in its API report\.\nIts members: get$/m,
		);
		fails(
			() => render(['KVStore.put']),
			ExitCode.Usage,
			/^KVStore has no member "put" in its API report\. Did you mean "KVStore\.get"\?\nIts members: get\nnpx --no -- cdk-blocks docs KVStore$/,
		);
	});

	it('looks up Owner.member through the bases the owner extends, nearest first, and says where it comes from', () => {
		const auth = 'export class Auth<const O extends AuthOptions = AuthOptions> extends AuthBase<O>';
		const protect = render(['Auth.protect']);
		assert.deepStrictEqual(protect.split('\n').slice(0, 4), [
			`Auth inherits protect from AuthBase: ${auth}`,
			'protect: member of AuthBase (@aws-blocks/bb-auth)',
			'',
			`# bb-auth/API.md (${join(dir, 'bb-auth', 'API.md')})`,
		]);
		assert.match(protect, /^ {4}protect<M extends ApiMethods>\(scope: ScopeParent, name: string/m);
		assert.match(protect, /^# bb-auth\/README\.md .*\n\(lines 3-5\)\n## Protect an API$/m);
		assert.match(render(['auth.ADMIN']), /^Auth inherits admin from AuthBase: .*\nadmin: member of AuthBase /);
		// Two levels up, through each head that extends the next.
		assert.strictEqual(
			render(['Auth.userPoolId']).split('\n')[0],
			`Auth inherits userPoolId from AuthRoot: ${auth}; export class AuthBase<const O extends AuthOptions = AuthOptions> extends AuthRoot<O> implements AuthShape<O>`,
		);
		// An interface's every base, and what an Omit of a base leaves out.
		assert.match(render(['AuthShape.readUser']), /^AuthShape inherits readUser from AuthReader: /);
		assert.match(render(['AuthShape.writeUser']), /^AuthShape inherits writeUser from AuthWriter: /);
		fails(
			() => render(['AuthShape.dropUser']),
			ExitCode.Usage,
			/^AuthShape has no member "dropUser" in its API report\.\nIts members: from AuthReader: readUser; from AuthWriter: writeUser$/m,
		);
	});

	it('lists inherited members, and suggests one, when the owner has no such member', () => {
		fails(
			() => render(['Auth.protekt']),
			ExitCode.Usage,
			/^Auth has no member "protekt" in its API report\. Did you mean "Auth\.protect"\?\nIts members: from AuthBase: admin, protect; from AuthRoot: userPoolId\nnpx --no -- cdk-blocks docs Auth$/,
		);
		// Bases that extend each other end the walk.
		fails(
			() => render(['LoopA.nope']),
			ExitCode.Usage,
			/^LoopA has no member "nope" in its API report\.\nIts members: loopA; from LoopB: loopB$/m,
		);
	});

	it('prints at most three blocks of a member in full and names the others with their lookup', () => {
		const out = render(['shared']);
		assert.match(out, /^Also in bb-w4: npx --no -- cdk-blocks docs W4Options\.shared$/m);
		assert.deepStrictEqual(out.match(/^# \S+\/API\.md/gm), ['# bb-w1/API.md', '# bb-w2/API.md', '# bb-w3/API.md']);
	});
});

describe('cdk-blocks docs --section, bare and with a topic', () => {
	it('lists the headings with slugs and line ranges, skipping # lines in code', () => {
		const out = render(['core'], { toc: true });
		assert.match(out, /^core\/README\.md: 16 lines; npx --no -- cdk-blocks docs core --section <topic>$/m);
		// A doc path's headings name the doc path, the way to print that file again.
		assert.strictEqual(
			render(['bb-distributed-table/DESIGN.md'], { toc: true }).split('\n')[0],
			'bb-distributed-table/DESIGN.md: 4 lines; npx --no -- cdk-blocks docs bb-distributed-table/DESIGN.md --section <topic>',
		);
		assert.match(
			render(['core'], { toc: true, api: true }),
			/^core\/API\.md: \d+ lines; npx --no -- cdk-blocks docs core --api --section <topic>$/m,
		);
		assert.match(out, /^ {2}Errors {2}\[errors\] {2}lines 10-14$/m);
		assert.match(out, /^ {4}Throwing {2}\[throwing\] {2}lines 12-14$/m);
		assert.doesNotMatch(out, /not a heading/);
		assert.deepStrictEqual(
			parseSections(FILES['core/README.md']).map((s) => [s.slug, s.start, s.end]),
			[
				['core', 1, 16],
				['namespaces', 3, 9],
				['errors', 10, 14],
				['throwing', 12, 14],
				['testing', 15, 16],
			],
		);
	});

	it('prints only the sections asked for, by slug or by title, subsections included', () => {
		const out = render(['core'], { sections: ['errors', 'Testing'] });
		assert.strictEqual(
			out,
			[
				`# core/README.md (${join(dir, 'core', 'README.md')})`,
				'(lines 10-14)',
				'## Errors',
				'',
				'### Throwing',
				"Throw `new ApiError('Not found', 404)`; the client gets the status.",
				'',
				'(lines 15-16)',
				'## Testing',
				'Run the tests.',
				'',
			].join('\n'),
		);
	});

	it('matches a heading by slug prefix or at a word start, never inside a word', () => {
		assert.match(render(['core'], { sections: ['throw'] }), /^\(lines 12-14\)\n### Throwing$/m);
		assert.match(render(['core'], { sections: ['test'] }), /^\(lines 15-16\)\n## Testing$/m);
		fails(() => render(['core'], { sections: ['rrors'] }), ExitCode.Usage, /no section "rrors"/);
	});

	it('names a looser match as such: a heading with every word by stem, else the lines that mention every word', () => {
		assert.match(
			render(['DistributedTable'], { sections: ['querying'] }),
			/^\(lines 3-5; closest heading to "querying"\)\n## Queries$/m,
		);
		assert.match(
			render(['DistributedTable'], { sections: ['conditional writes'] }),
			/^\(lines 6-11; no heading names "conditional writes"; these lines mention every word of it\)\n## Conditional Operations$/m,
		);
		assert.match(
			render(['DistributedTable'], { sections: ['scan'] }),
			/^\(lines 3-5; no heading names "scan"; these lines mention every word of it\)\n## Queries\nUse an index; never scan\./m,
		);
	});

	it('never serves a heading that shares only one of the words asked for', () => {
		const caching = render(['bb-secret'], { sections: ['Read caching'] });
		assert.match(
			caching,
			/^\(lines 6-7; no heading names "Read caching"; these lines mention every word of it\)\n## Usage$/m,
		);
		assert.doesNotMatch(caching, /Read-only by default/);
		fails(
			() => render(['bb-secret'], { sections: ['read rotation'] }),
			ExitCode.Usage,
			/no section "read rotation"\.[\s\S]*Its sections: read-only-by-default, usage/,
		);
	});

	it("finds a topic no heading names in the block's other docs when the README does not mention it", () => {
		const out = render(['bb-locker'], { sections: ['form'] });
		assert.match(out, /^# bb-locker\/CUSTOM\.md \(/m);
		assert.match(
			out,
			/^\(lines 3-\d+; no heading names "form"; these lines mention every word of it\)\n## Depth 3/m,
		);
	});

	it("answers from the README's lines before a subsection of another doc that one word of the topic starts", () => {
		// CUSTOM.md's "Durability & Security" starts with the word, which does not name it; the README mentions it.
		const durability = render(['bb-locker'], { sections: ['durability'] });
		assert.match(durability, /^# bb-locker\/README\.md \(/);
		assert.match(
			durability,
			/^\(lines 6-\d+; no heading names "durability"; these lines mention every word of it\)\n## Writing$/m,
		);
		assert.doesNotMatch(durability, /CUSTOM\.md|Durability & Security/);
		// A heading that names the topic wins over the README's mention: a subsection by a topic of several words, or
		// the doc's title.
		assert.match(
			render(['bb-locker'], { sections: ['Depth 3'] }),
			/^# bb-locker\/CUSTOM\.md \(.*\)\n\(lines 3-5\)\n## Depth 3/m,
		);
		assert.match(
			render(['bb-locker'], { sections: ['cust'] }),
			/^# bb-locker\/CUSTOM\.md \(.*\)\n\(lines 1-\d+\)\n# Custom$/m,
		);
	});

	it('names the members whose value an error name is, and what other packages a filter names', () => {
		assert.strictEqual(
			render(['HubClosedException']).split('\n')[0],
			'HubClosedException: the value of HubErrors.Closed (@aws-blocks/bb-hub)',
		);
		assert.match(
			render(['spec'], { exports: true }),
			/^Names from other packages: StandardSchemaV1 \(from @standard-schema\/spec\)$/m,
		);
	});

	it('answers a grep alternation with the first heading one of its alternatives names, and points at other blocks', () => {
		assert.match(
			render(['DistributedTable'], { sections: ['nothing-here\\|Queries'] }),
			/^\(lines 3-5\)\n## Queries$/m,
		);
		fails(
			() => render(['KVStore'], { sections: ['Conditional Operations'] }),
			ExitCode.Usage,
			/^Other blocks have it: npx --no -- cdk-blocks docs bb-distributed-table --section conditional-operations$/m,
		);
		assert.match(
			render(['DistributedTable'], { sections: ['Quick'] }),
			/^\(lines 6-11; no "Quick" heading; the first section with an example\)$/m,
		);
	});

	it('answers "Quick start" and the like with the first section that has an example', () => {
		for (const wanted of ['Quick start', 'quick-start', 'Getting started']) {
			assert.match(
				render(['DistributedTable'], { sections: [wanted] }),
				new RegExp(
					`^\\(lines 6-11; no "${wanted}" heading; the first section with an example\\)\\n## Conditional Operations$`,
					'm',
				),
			);
		}
	});

	it("finds a heading in the block's other docs when its README has none, as written or with HTML entities", () => {
		const depth = render(['bb-locker'], { sections: ['Depth 3'] });
		assert.match(depth, /^# bb-locker\/CUSTOM\.md \(/m);
		assert.match(depth, /^\(lines 3-5\)\n## Depth 3: fully custom UI\nBuild your own form\.$/m);
		assert.match(
			render(['bb-locker'], { sections: ['Durability &amp; Security'] }),
			/^## Durability & Security\nDefaults\.$/m,
		);
		// The doc's own name names it.
		assert.match(render(['CUSTOM']), /^# bb-locker\/CUSTOM\.md \(.*\)\n# Custom$/m);
	});

	it('names what the reports import from a package outside AWS Blocks, named by its package', () => {
		assert.strictEqual(
			render(['@standard-schema/spec']).split('\n')[0],
			'@standard-schema/spec: a package outside AWS Blocks. The API reports import from it: StandardSchemaV1 (bb-kv-store)',
		);
	});

	it('rejects an unknown section with the closest heading, and reads --section in each of several blocks', () => {
		fails(
			() => render(['core'], { sections: ['erors'] }),
			ExitCode.Usage,
			/no section "erors"\. Did you mean "errors"\?\nIts sections: namespaces, errors, throwing, testing\n[\s\S]*, or npx --no -- cdk-blocks docs core --section$/,
		);
		const both = render(['core', 'DistributedTable'], { sections: ['errors|queries'] });
		assert.match(both, /^# core\/README\.md \([^)]*\)\n\(lines 10-\d+\)\n## Errors$/m);
		assert.match(both, /^# bb-distributed-table\/README\.md \([^)]*\)\n\(lines 3-5\)\n## Queries$/m);
	});
});

describe('cdk-blocks docs --exports', () => {
	it("lists by package every name @aws-blocks/blocks exports, its own declarations over a wildcard's, then each entry's", () => {
		const out = render([], { exports: true });
		assert.match(
			out,
			/^Names you can import from @aws-blocks\/blocks in backend code \(\d+\): import \{ <name> \} from '@aws-blocks\/blocks';$/m,
		);
		assert.match(out, /^ {2}@aws-blocks\/bb-distributed-table: DTPutOptions \(PutOptions\)$/m);
		assert.match(out, /^ {2}@aws-blocks\/bb-kv-store: KVPutOptions \(PutOptions\), KVStore$/m);
		assert.match(out, /^ {2}@aws-blocks\/blocks: getSdkIdentifiers$/m);
		// A report's `_` exports are importable too: listed, though cards leave them out.
		assert.match(out, /^ {2}@aws-blocks\/core: _resetCache, ApiError, internalHelper$/m);
		assert.match(out, /^ {2}@aws-blocks\/hosting: config$/m);
		assert.ok(
			out.endsWith(
				[
					'Browser code and tests (npm run test:e2e runs tsx -C browser) get no value from @aws-blocks/blocks (import type of its types works); they import values from @aws-blocks/blocks/client.',
					"The other entries' names: import { <name> } from '<entry>';",
					'  @aws-blocks/blocks/client (7): ApiError, ApiNamespaceClient, BlocksContext, BlocksRequest, isBlocksError, Scope, ScopeOptions',
					'  @aws-blocks/blocks/ui (3): Authenticator, AuthStateApi, onAuthChange',
					'Its declaration and docs: npx --no -- cdk-blocks docs <name>',
					'',
				].join('\n'),
			),
			out,
		);
		assert.doesNotMatch(out, /kvKeyOf|cdkOnly|\/cdk|lambda-handler/);
	});

	it('filters by the names after it, one line per name with its kind, the declaration an alias is and its entries', () => {
		const out = render(['putoptions', 'error', 'authchange'], { exports: true });
		assert.deepStrictEqual(out.split('\n').slice(0, 7), [
			'Names you can import from @aws-blocks/blocks in backend code containing "putoptions" or "error" or "authchange" (3): import { <name> } from \'@aws-blocks/blocks\';',
			'Browser code and tests (npm run test:e2e runs tsx -C browser) get no value from @aws-blocks/blocks (import type of its types works); they import values from @aws-blocks/blocks/client. Other entries as marked.',
			'  ApiError       class in @aws-blocks/core; also from @aws-blocks/blocks/client',
			'  DTPutOptions   type in @aws-blocks/bb-distributed-table (PutOptions there)',
			'  isBlocksError  only from @aws-blocks/blocks/client',
			'  KVPutOptions   interface in @aws-blocks/bb-kv-store (PutOptions there)',
			'  onAuthChange   only from @aws-blocks/blocks/ui',
		]);
		fails(
			() => render(['nothing-like-it'], { exports: true }),
			ExitCode.Failure,
			/exports no name containing "nothing-like-it"/,
		);
		fails(() => render([], { exports: true, api: true }), ExitCode.Usage, /--exports does not combine/);
	});

	it("lists an entry's names for a filter that names the entry, and filters names by the others", () => {
		const ui = [
			"@aws-blocks/blocks/ui (3 names): import { <name> } from '@aws-blocks/blocks/ui';",
			'  Authenticator, AuthStateApi, onAuthChange',
			"A name's declaration: npx --no -- cdk-blocks docs <name>",
			'',
		].join('\n');
		assert.strictEqual(render(['ui'], { exports: true }), ui);
		assert.strictEqual(render(['@aws-blocks/blocks/ui'], { exports: true }), ui);
		const both = render(['UI', 'putoptions'], { exports: true });
		assert.ok(both.startsWith(ui), both);
		assert.match(
			both,
			/^Names you can import from @aws-blocks\/blocks in backend code containing "putoptions" \(2\)/m,
		);
	});
});

describe('cdk-blocks docs --exports, when no export has the filter', () => {
	it('names the declarations it does not re-export, the members and the names from other packages that have it', () => {
		assert.match(
			render(['kvkey'], { exports: true }),
			/^Declared by a block it does not re-export: kvKeyOf \(import from @aws-blocks\/bb-kv-store\)$/m,
		);
		assert.strictEqual(
			render(['iffield', 'standard'], { exports: true }),
			[
				'@aws-blocks/blocks exports no name containing "iffield" or "standard".',
				'Members that contain it: ifFieldEquals (of PutOptions)',
				'Names from other packages: StandardSchemaV1 (from @standard-schema/spec)',
				"A name's declaration and docs: npx --no -- cdk-blocks docs <name>",
				'',
			].join('\n'),
		);
	});
});

describe('cdk-blocks docs --search', () => {
	it('prints each matching line with its file, line and section, in every doc or only the named blocks', () => {
		const all = render([], { search: 'limit' });
		assert.match(
			all,
			/^bb-distributed-table\/README\.md:4 \[queries\]: Use an index; never scan\. limit caps the page\.$/m,
		);
		assert.match(all, /^bb-kv-store\/README\.md:6 \[usage\]: get and put by key; limit is not supported\.$/m);
		const narrowed = render(['KVStore'], { search: 'LIMIT' });
		assert.doesNotMatch(narrowed, /bb-distributed-table/);
		assert.match(narrowed, /^bb-kv-store\/README\.md:6 /m);
		// Every README hit comes before any DESIGN.md hit, whatever the folder order.
		assert.ok(all.indexOf('bb-kv-store/README.md') < all.indexOf('bb-distributed-table/DESIGN.md'), all);
	});

	it('reads the blocks that declare an export or option named in place of a block', () => {
		const out = render(['ApiError'], { search: 'status' });
		assert.match(out, /^core\/API\.md:\d+: readonly status: number;$/m);
		assert.doesNotMatch(out, /bb-|^API\.md/m);
		fails(() => render(['nothing-named-so'], { search: 'status' }), ExitCode.Usage, /no block, export or option/);
	});

	it('falls back to the lines that mention every word of the term, then to the other docs, and says so', () => {
		assert.match(
			render([], { search: 'failed-written' }),
			/^no line has "failed-written"; the lines that mention failed and written:\nbb-distributed-table\/README\.md:11 \[conditional-operations\]: A failed condition/m,
		);
		assert.match(
			render(['KVStore'], { search: 'ifFieldEquals' }),
			/^bb-kv-store does not mention "ifFieldEquals"; other docs do:\nbb-distributed-table\/README\.md:9 /m,
		);
		assert.match(
			render(['KVStore'], { search: 'failed-written' }),
			/^bb-kv-store does not mention "failed-written"; in other docs, the lines that mention failed and written:\nbb-distributed-table\/README\.md:11 /m,
		);
	});

	it("matches any alternative of grep's a|b, and prints the card of a name no doc mentions", () => {
		for (const term of ['nowhere-x|ifFieldEquals', 'nowhere-x\\|ifFieldEquals']) {
			assert.match(
				render([], { search: term }),
				/^no line has ".*"; the lines that have "nowhere-x" or "iffieldequals":\nbb-distributed-table\/README\.md:9 /m,
			);
		}
		assert.match(
			render([], { search: 'onAuthChange' }),
			/^no doc mentions "onAuthChange"; it is a name you can look up:\nonAuthChange: function in @aws-blocks\/blocks\. import \{ onAuthChange \} from '@aws-blocks\/blocks\/ui';/m,
		);
	});

	it('fails when nothing matches, and does not combine with a section topic or --api', () => {
		fails(() => render([], { search: 'nowhere-at-all' }), ExitCode.Failure, /no doc mentions "nowhere-at-all"/);
		fails(() => render([], { search: 'limit', sections: ['usage'] }), ExitCode.Usage, /--search does not combine/);
		fails(() => render([], { search: 'limit', api: true }), ExitCode.Usage, /--search does not combine/);
		// A bare --section asks for nothing a search does not print: each hit names its section.
		assert.strictEqual(
			render(['KVStore'], { search: 'limit', toc: true }),
			render(['KVStore'], { search: 'limit' }),
		);
	});
});

describe('cdk-blocks docs (no name)', () => {
	it('lists every block with its classes, purpose and other files, then the framework docs as files', () => {
		const out = render([]);
		assert.match(out, /^AWS Blocks docs for @aws-blocks\/blocks 1\.2\.3 \(folder: /);
		assert.match(
			out,
			/^ {2}bb-distributed-table {2}DistributedTable: Tables with indexes\. \[API\.md, DESIGN\.md\]$/m,
		);
		assert.match(out, /^ {2}bb-kv-store {11}KVStore: Values by key\. \[API\.md\]$/m);
		assert.match(
			out,
			/^Framework docs \(each name is one file of the docs folder, not a folder\):\n {2}guide {17}README\.md of @aws-blocks\/blocks: How an app[^\n]*\n {2}troubleshooting {7}TROUBLESHOOTING\.md of @aws-blocks\/blocks: /m,
		);
		fails(() => render([], { api: true }), ExitCode.Usage, /name a block/);
		assert.strictEqual(render([], { toc: true }), out);
	});

	it('names the forms and options of --help in its usage block, and no removed option', () => {
		const out = render([]);
		const usage = out.slice(out.indexOf('Usage:'), out.indexOf('\nBlocks ('));
		assert.ok(usage.startsWith('Usage: npx --no -- cdk-blocks docs [name...] [options]\n'), usage);
		for (const form of ['npx --no -- cdk-blocks docs <block>...', 'npx --no -- cdk-blocks docs <name>...']) {
			assert.ok(usage.includes(`\n  ${form} `), form);
		}
		for (const option of ['--api', '--section <topic>', '--exports [filter...]', '--search <term>']) {
			assert.match(usage, new RegExp(`^ {2}${option.replace(/[.[\]]/g, '\\$&')} +\\S`, 'm'), option);
		}
		assert.doesNotMatch(out, /--(?:source|toc|design)\b/);
	});
});

describe('cdk-blocks docs through the CLI', () => {
	it('prints the shipped docs from any directory, and rejects --output json', async () => {
		const run = await runCli(['docs', 'DistributedTable', '--api'], { cwd: tmpdir() });
		assert.strictEqual(run.code, 0, run.stderr);
		assert.match(run.stdout, /^# bb-distributed-table\/API\.md \(\/.*\/docs\/bb-distributed-table\/API\.md\)\n/);
		const json = await runCli(['docs', 'core', '--output', 'json'], { cwd: tmpdir() });
		assert.strictEqual(json.code, ExitCode.Usage);
	});

	it('reads a bare --section at the end of the line as the headings', async () => {
		const run = await runCli(['docs', 'KVStore', '--section'], { cwd: tmpdir() });
		assert.strictEqual(run.code, 0, run.stderr);
		assert.match(
			run.stdout,
			/^bb-kv-store\/README\.md: \d+ lines; npx --no -- cdk-blocks docs bb-kv-store --section <topic>\n/,
		);
	});

	it('reads a bare --section before another option as the headings, and still parses that option', async () => {
		const api = await runCli(['docs', 'DistributedTable', '--section', '--api'], { cwd: tmpdir() });
		assert.strictEqual(api.code, 0, api.stderr);
		assert.match(
			api.stdout,
			/^bb-distributed-table\/API\.md: \d+ lines; npx --no -- cdk-blocks docs bb-distributed-table --api --section <topic>\n/,
		);
		const search = await runCli(['docs', 'core', '--section', '--search', 'withAuth'], { cwd: tmpdir() });
		assert.strictEqual(search.code, 0, search.stderr);
		assert.match(search.stdout, /^search "withAuth" in /);
		assert.match(search.stdout, /^core\/README\.md:\d+ \[withauth/m);
	});

	it("finds bb-auth's Auth.protect and Auth.admin on AuthBase, which Auth extends", async () => {
		for (const member of ['protect', 'admin']) {
			const run = await runCli(['docs', `Auth.${member}`], { cwd: tmpdir() });
			assert.strictEqual(run.code, 0, run.stderr);
			assert.match(
				run.stdout,
				new RegExp(
					`^Auth inherits ${member} from AuthBase: export class Auth<.*\\n${member}: member of AuthBase \\(@aws-blocks/bb-auth\\)\\n`,
				),
			);
		}
	});

	it('rejects --source, --toc and --design as it rejects any option docs does not have', async () => {
		for (const flag of ['--nonsense', '--source', '--toc', '--design']) {
			const run = await runCli(['docs', 'KVStore', flag], { cwd: tmpdir() });
			assert.strictEqual(run.code, ExitCode.Usage, flag);
			assert.strictEqual(run.stdout, '', flag);
			assert.match(
				run.stderr,
				new RegExp(
					`^Error: unknown option "${flag}" for "cdk-blocks docs"\\.(?: Did you mean "--[a-z]+"\\?)?\\nTry: npx --no -- cdk-blocks docs --help\\n$`,
				),
				flag,
			);
		}
	});

	it("drops grep's flags and -- after --search, taking the next argument as the term", async () => {
		for (const argv of [
			['docs', 'DistributedTable', '--search', '-i', 'consistentRead'],
			['docs', '--search', '-in', 'consistentRead', 'DistributedTable'],
			['docs', 'DistributedTable', '--search', '--', 'consistentRead'],
		]) {
			const run = await runCli(argv, { cwd: tmpdir() });
			assert.strictEqual(run.code, 0, `${argv.join(' ')}: ${run.stderr}`);
			assert.match(run.stdout, /^search "consistentRead" in /, argv.join(' '));
			assert.match(run.stdout, /^bb-distributed-table\/README\.md:\d+ /m, argv.join(' '));
			assert.doesNotMatch(run.stdout, /^bb-kv-store\//m, argv.join(' '));
		}
		const bare = await runCli(['docs', '--search', '-i'], { cwd: tmpdir() });
		assert.strictEqual(bare.code, ExitCode.Usage);
		assert.match(bare.stderr, /option --search needs a value/);
	});

	it('reads arguments after -- as names, as POSIX does', async () => {
		const run = await runCli(['docs', '--exports', '--', 'Error'], { cwd: tmpdir() });
		assert.strictEqual(run.code, 0, run.stderr);
		assert.match(
			run.stdout,
			/^Names you can import from @aws-blocks\/blocks in backend code containing "Error" \(/,
		);
	});
});
