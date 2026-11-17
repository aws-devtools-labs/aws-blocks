// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { BlocksResult } from './data-provider.js';
import { LocalDataProvider } from './local-provider.js';
import { REDACTED } from './redact.js';
import type { RawTemplate } from './resources.js';
import type { StoredParameter } from './settings-store.js';

/*
 * The guarantee here is behavioural, not textual: listing a stage must make NO
 * decrypted read, however many secrets it contains. These tests therefore COUNT
 * invocations of the decrypt seam rather than reading the response's own
 * `masked` flags and trusting them. A response that claims to be masked while
 * having already pulled every plaintext out of the account is the exact failure
 * this must catch.
 */
const DISCOVERY: BlocksResult = {
	blocksSource: 'source-scan',
	projectName: 'shop',
	scope: { id: 'shop', file: 'aws-blocks/index.ts', line: 1 },
	unknownConstructs: [],
	scannedFiles: 1,
	blocks: [
		{
			type: 'AppSetting',
			id: 'flag',
			fullId: 'shop-flag',
			category: 'config',
			file: 'aws-blocks/index.ts',
			line: 3,
			setting: {
				parameterName: '/shop-flag',
				nameSource: 'derived',
				secret: false,
				hasSchema: false,
				external: false,
			},
		},
		{
			type: 'AppSetting',
			id: 'token',
			fullId: 'shop-token',
			category: 'config',
			file: 'aws-blocks/index.ts',
			line: 4,
			setting: {
				parameterName: '/shop-token',
				nameSource: 'derived',
				secret: true,
				hasSchema: false,
				external: false,
			},
		},
		{
			type: 'KVStore',
			id: 'cache',
			fullId: 'shop-cache',
			category: 'data',
			file: 'aws-blocks/index.ts',
			line: 5,
		},
	],
};

/**
 * The deployed template, carrying the parameter paths in the STACK-PREFIXED
 * form a real deploy produces. An earlier version of this fixture used the bare
 * `/shop-flag`, which is the mock's shape, and that is precisely what hid a bug
 * where every deployed setting read as absent.
 */
const TEMPLATE: RawTemplate = {
	Resources: {
		Flag: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/shop-abc123-prod-shop-flag' } },
		Limits: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/shop-abc123-prod-shop-limits' } },
		BlocksSecretsBulk: {
			Type: 'AWS::CloudFormation::CustomResource',
			Properties: { ParameterNames: ['/shop-abc123-prod-shop-token'] },
		},
		Handler: {
			Type: 'AWS::Lambda::Function',
			Properties: {
				Environment: { Variables: { BLOCKS_CONFIG_KEY: 'blocks-config.json', TABLE: { Ref: 'Users' } } },
			},
		},
	},
};

describe('LocalDataProvider settings', () => {
	let tmpDir: string;

	function makeProject(settingsJson?: Record<string, unknown>): string {
		tmpDir = join(tmpdir(), `admin-ui-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tmpDir, '.blocks'), { recursive: true });
		writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'shop' }));
		writeFileSync(join(tmpDir, '.blocks/config.json'), JSON.stringify({ stackId: 'shop-abc123' }));
		if (settingsJson) {
			mkdirSync(join(tmpDir, '.bb-data'), { recursive: true });
			writeFileSync(join(tmpDir, '.bb-data/settings.json'), JSON.stringify(settingsJson));
		}
		return tmpDir;
	}

	afterEach(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	/** A provider whose SSM seams are counted, so the no-decryption claim is provable. */
	function countingProvider(
		options: {
			values?: Map<string, StoredParameter>;
			valuesError?: Error;
			template?: RawTemplate;
			templateError?: Error;
			settingsJson?: Record<string, unknown>;
		} = {},
	) {
		const calls = {
			list: [] as string[][],
			decrypt: [] as string[],
			history: [] as Array<[string, boolean]>,
			put: [] as Array<[string, string, boolean]>,
			localWrite: [] as Array<[string, unknown]>,
		};
		const provider = new LocalDataProvider(
			makeProject(options.settingsJson),
			undefined, // fetchEvents
			undefined, // fetchResources
			undefined, // fetchLogMetadata
			undefined, // runInsights
			async () => {
				if (options.templateError) throw options.templateError;
				return options.template ?? TEMPLATE;
			},
			undefined, // fetchDescription
			undefined, // fetchCostTags
			undefined, // fetchCosts
			undefined, // runDoctorImpl
			() => DISCOVERY,
			undefined, // readLocalDataImpl
			undefined, // readCloudDataImpl
			undefined, // putLocalRecordImpl
			undefined, // deleteLocalRecordImpl
			undefined, // putCloudRecordImpl
			undefined, // deleteCloudRecordImpl
			undefined, // buildRpcMethodCatalogueImpl
			undefined, // resolveRpcEndpointImpl
			undefined, // invokeRpcImpl
			undefined, // fetchMetricDataImpl
			async (names) => {
				calls.list.push([...names]);
				if (options.valuesError) throw options.valuesError;
				return options.values ?? new Map();
			},
			async (name) => {
				calls.decrypt.push(name);
				return { raw: '"plaintext-secret"', type: 'SecureString', version: 4 };
			},
			async (name, secret) => {
				calls.history.push([name, secret]);
				return [{ version: 4 }, { version: 3 }];
			},
			undefined, // readLocalSettingsImpl: the real file, written by makeProject
			async (name, value, putOptions) => {
				calls.put.push([name, value, putOptions.secret]);
				return 9;
			},
			(_root, fullId, value) => {
				calls.localWrite.push([fullId, value]);
			},
		);
		return { provider, calls };
	}

	it('lists a deployed stage without ever decrypting', async () => {
		const values = new Map<string, StoredParameter>([
			['/shop-abc123-prod-shop-flag', { raw: '"on"', type: 'String', version: 2 }],
			['/shop-abc123-prod-shop-token', { type: 'SecureString', version: 5 }],
		]);
		const { provider, calls } = countingProvider({ values });

		const result = await provider.listSettings({ stage: 'production', mode: 'cloud' });

		assert.equal(calls.decrypt.length, 0, 'listing must make no decrypted read');
		assert.deepEqual(
			result.settings.map((entry) => [entry.fullId, entry.value?.display]),
			[
				['shop-flag', 'on'],
				['shop-token', REDACTED],
			],
		);
		// The block that carries no value is not a settings row.
		assert.equal(result.settings.length, 2);
	});

	it('asks for the secret names the template carries, which no parameter resource names', async () => {
		const { provider, calls } = countingProvider();

		await provider.listSettings({ stage: 'production', mode: 'cloud' });

		// Both declared parameters plus the one the template creates that this
		// DISCOVERY fixture does not declare, which is how an orphan is found.
		assert.deepEqual(calls.list, [
			['/shop-abc123-prod-shop-flag', '/shop-abc123-prod-shop-token', '/shop-abc123-prod-shop-limits'],
		]);
	});

	it('shows the handler environment as deploy-owned, naming nothing it cannot resolve', async () => {
		const { provider } = countingProvider();

		const result = await provider.listSettings({ stage: 'production', mode: 'cloud' });

		assert.deepEqual(result.environment, [
			{ key: 'BLOCKS_CONFIG_KEY', value: 'blocks-config.json', deployTime: false },
			{ key: 'TABLE', deployTime: true },
		]);
	});

	it('reports a refused read as a refusal rather than as an empty list', async () => {
		const denied = Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' });
		const { provider } = countingProvider({ valuesError: denied });

		const result = await provider.listSettings({ stage: 'production', mode: 'cloud' });

		assert.equal(result.settingsErrorCode, 'ACCESS_DENIED');
		assert.deepEqual(result.settings, []);
	});

	it('separates a stage that is not deployed from one that refused', async () => {
		const missing = Object.assign(new Error('Stack with id shop-abc123 does not exist'), {
			name: 'ValidationError',
		});
		const { provider } = countingProvider({ templateError: missing });

		const result = await provider.listSettings({ stage: 'production', mode: 'cloud' });

		assert.equal(result.settingsErrorCode, 'NOT_DEPLOYED');
	});

	it('addresses local mode by fullId out of the mock file', async () => {
		const { provider, calls } = countingProvider({
			settingsJson: { 'shop-flag': 'local-on', 'shop-token': 'local-secret' },
		});

		const result = await provider.listSettings({ stage: 'local', mode: 'local' });

		// No AWS call at all in local mode, decrypted or otherwise.
		assert.equal(calls.list.length, 0);
		assert.equal(calls.decrypt.length, 0);
		assert.deepEqual(
			result.settings.map((entry) => [entry.address, entry.value?.display]),
			[
				['shop-flag', 'local-on'],
				['shop-token', REDACTED],
			],
		);
	});

	it('reveals one value only when the id names a declared setting', async () => {
		const { provider, calls } = countingProvider();

		const revealed = await provider.revealSetting({ stage: 'production', mode: 'cloud', fullId: 'shop-token' });

		assert.equal(revealed?.display, 'plaintext-secret');
		assert.deepEqual(calls.decrypt, ['/shop-abc123-prod-shop-token']);
	});

	/**
	 * The route takes an id, never a parameter path. An unknown id must not
	 * reach the SSM call at all, or the feature would be a reader for every
	 * parameter the developer's credentials can see.
	 */
	it('refuses an id no declaration claims, without calling AWS', async () => {
		const { provider, calls } = countingProvider();

		const revealed = await provider.revealSetting({
			stage: 'production',
			mode: 'cloud',
			fullId: '/aws/reference/secretsmanager/prod-db-password',
		});

		assert.equal(revealed, undefined);
		assert.equal(calls.decrypt.length, 0);
	});

	it('passes the secret flag into history, so past values are dropped', async () => {
		const { provider, calls } = countingProvider();

		const history = await provider.listSettingVersions({
			stage: 'production',
			mode: 'cloud',
			fullId: 'shop-token',
		});

		assert.deepEqual(calls.history, [['/shop-abc123-prod-shop-token', true]]);
		assert.equal(history.secret, true);
		assert.deepEqual(
			history.versions.map((version) => version.version),
			[4, 3],
		);
	});

	it('offers no history locally, because the mock keeps one value per setting', async () => {
		const { provider, calls } = countingProvider({ settingsJson: { 'shop-flag': 'on' } });

		const history = await provider.listSettingVersions({ stage: 'local', mode: 'local', fullId: 'shop-flag' });

		assert.deepEqual(history.versions, []);
		assert.equal(calls.history.length, 0);
	});
});

describe('LocalDataProvider.writeSetting', () => {
	let tmpDir: string;

	function makeProject(): string {
		tmpDir = join(tmpdir(), `admin-ui-settings-write-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tmpDir, '.blocks'), { recursive: true });
		writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'shop' }));
		writeFileSync(join(tmpDir, '.blocks/config.json'), JSON.stringify({ stackId: 'shop-abc123' }));
		return tmpDir;
	}

	afterEach(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	const WITH_SCHEMA: BlocksResult = {
		...DISCOVERY,
		blocks: [
			...DISCOVERY.blocks,
			{
				type: 'AppSetting',
				id: 'limits',
				fullId: 'shop-limits',
				category: 'config',
				file: 'aws-blocks/index.ts',
				line: 6,
				setting: {
					parameterName: '/shop-limits',
					nameSource: 'derived',
					secret: false,
					hasSchema: true,
					external: false,
				},
			},
			{
				type: 'AppSetting',
				id: 'db-url',
				fullId: 'shop-db-url',
				category: 'config',
				file: 'aws-blocks/index.ts',
				line: 7,
				setting: { nameSource: 'unresolved', secret: true, hasSchema: false, external: true },
			},
		],
	};

	function writer(options: { values?: Map<string, StoredParameter>; putError?: Error } = {}) {
		const calls = { put: [] as Array<[string, string, boolean]>, local: [] as Array<[string, unknown]>, list: 0 };
		const provider = new LocalDataProvider(
			makeProject(),
			undefined, // fetchEvents
			undefined, // fetchResources
			undefined, // fetchLogMetadata
			undefined, // runInsights
			async () => TEMPLATE,
			undefined, // fetchDescription
			undefined, // fetchCostTags
			undefined, // fetchCosts
			undefined, // runDoctorImpl
			() => WITH_SCHEMA,
			undefined, // readLocalDataImpl
			undefined, // readCloudDataImpl
			undefined, // putLocalRecordImpl
			undefined, // deleteLocalRecordImpl
			undefined, // putCloudRecordImpl
			undefined, // deleteCloudRecordImpl
			undefined, // buildRpcMethodCatalogueImpl
			undefined, // resolveRpcEndpointImpl
			undefined, // invokeRpcImpl
			undefined, // fetchMetricDataImpl
			async () => {
				calls.list += 1;
				return options.values ?? new Map();
			},
			undefined, // fetchDecryptedParameterImpl
			undefined, // fetchParameterHistoryImpl
			undefined, // readLocalSettingsImpl
			async (name, value, putOptions) => {
				calls.put.push([name, value, putOptions.secret]);
				if (options.putError) throw options.putError;
				return 9;
			},
			(_root, fullId, value) => {
				calls.local.push([fullId, value]);
			},
		);
		return { provider, calls };
	}

	/**
	 * The encoding is the whole correctness of the write. `get()` runs
	 * JSON.parse, so storing the typed text verbatim would hand the app the
	 * NUMBER 5 where the user meant the string.
	 */
	it('stores text encoded exactly as the app would have stored it', async () => {
		const { provider, calls } = writer();

		const result = await provider.writeSetting({
			stage: 'production',
			mode: 'cloud',
			fullId: 'shop-flag',
			input: '5',
			kind: 'text',
		});

		assert.equal(result.ok, true);
		assert.deepEqual(calls.put, [['/shop-abc123-prod-shop-flag', '"5"', false]]);
		assert.equal(result.stored?.version, 9);
	});

	it('keeps a secret a SecureString', async () => {
		const { provider, calls } = writer();

		await provider.writeSetting({
			stage: 'production',
			mode: 'cloud',
			fullId: 'shop-token',
			input: 'new-token-value',
			kind: 'text',
		});

		// Writing a secret as a String would downgrade it from KMS-encrypted to
		// plaintext, which is the kind of change nobody notices until it is in
		// a log.
		assert.deepEqual(calls.put, [['/shop-abc123-prod-shop-token', '"new-token-value"', true]]);
	});

	it('masks the secret it just stored rather than echoing it back', async () => {
		const { provider } = writer();

		const result = await provider.writeSetting({
			stage: 'production',
			mode: 'cloud',
			fullId: 'shop-token',
			input: 'new-token-value',
			kind: 'text',
		});

		assert.equal(result.stored?.display, REDACTED);
		assert.ok(!JSON.stringify(result).includes('new-token-value'));
	});

	it('refuses an id no declaration claims, without writing anything', async () => {
		const { provider, calls } = writer();

		const result = await provider.writeSetting({
			stage: 'production',
			mode: 'cloud',
			fullId: '/aws/reference/secretsmanager/prod-db',
			input: 'x',
			kind: 'text',
		});

		assert.equal(result.refusalCode, 'not-declared');
		assert.equal(calls.put.length, 0);
	});

	it('refuses input the caller called JSON but is not, before writing', async () => {
		const { provider, calls } = writer();

		const result = await provider.writeSetting({
			stage: 'production',
			mode: 'cloud',
			fullId: 'shop-flag',
			input: '{retries: 3}',
			kind: 'json',
		});

		assert.equal(result.refusalCode, 'invalid-json');
		assert.equal(calls.put.length, 0);
	});

	it('refuses to empty a secret', async () => {
		const { provider, calls } = writer();

		const result = await provider.writeSetting({
			stage: 'production',
			mode: 'cloud',
			fullId: 'shop-token',
			input: '',
			kind: 'text',
		});

		assert.equal(result.refusalCode, 'empty-secret');
		assert.equal(calls.put.length, 0);
	});

	it('refuses a setting whose path cannot be read from source', async () => {
		const { provider, calls } = writer();

		const result = await provider.writeSetting({
			stage: 'production',
			mode: 'cloud',
			fullId: 'shop-db-url',
			input: 'rotated',
			kind: 'text',
		});

		assert.equal(result.refusalCode, 'unaddressable');
		assert.equal(calls.put.length, 0);
		assert.match(result.message, /seeded|literal name/);
	});

	/**
	 * Two tabs, or a form left open. SSM has no conditional put, so this is a
	 * read-then-write check and not atomic, but it turns the common case from a
	 * silent clobber into a refusal.
	 */
	it('refuses to overwrite a value that moved since the caller read it', async () => {
		const values = new Map<string, StoredParameter>([
			['/shop-abc123-prod-shop-flag', { type: 'String', version: 12 }],
		]);
		const { provider, calls } = writer({ values });

		const result = await provider.writeSetting({
			stage: 'production',
			mode: 'cloud',
			fullId: 'shop-flag',
			input: 'on',
			kind: 'text',
			expectedVersion: 11,
		});

		assert.equal(result.refusalCode, 'version-conflict');
		assert.match(result.message, /version 11.*now 12/);
		assert.equal(calls.put.length, 0);
	});

	it('writes when the version is the one the caller read', async () => {
		const values = new Map<string, StoredParameter>([
			['/shop-abc123-prod-shop-flag', { type: 'String', version: 11 }],
		]);
		const { provider, calls } = writer({ values });

		const result = await provider.writeSetting({
			stage: 'production',
			mode: 'cloud',
			fullId: 'shop-flag',
			input: 'on',
			kind: 'text',
			expectedVersion: 11,
		});

		assert.equal(result.ok, true);
		assert.equal(calls.put.length, 1);
	});

	it('says when the app validates a setting with a schema this write did not run', async () => {
		const { provider } = writer();

		const result = await provider.writeSetting({
			stage: 'production',
			mode: 'cloud',
			fullId: 'shop-limits',
			input: '{"retries":3}',
			kind: 'json',
		});

		assert.equal(result.ok, true);
		assert.equal(result.schemaUnchecked, true);
	});

	it('reports a refused write as a refusal rather than throwing', async () => {
		const denied = Object.assign(new Error('not authorized to perform ssm:PutParameter'), {
			name: 'AccessDeniedException',
		});
		const { provider } = writer({ putError: denied });

		const result = await provider.writeSetting({
			stage: 'production',
			mode: 'cloud',
			fullId: 'shop-flag',
			input: 'on',
			kind: 'text',
		});

		assert.equal(result.refusalCode, 'unreachable');
		assert.match(result.message, /PutParameter/);
	});

	it('writes local mode to the mock file and never to AWS', async () => {
		const { provider, calls } = writer();

		const result = await provider.writeSetting({
			stage: 'local',
			mode: 'local',
			fullId: 'shop-limits',
			input: '{"retries":3}',
			kind: 'json',
		});

		assert.equal(result.ok, true);
		assert.equal(calls.put.length, 0);
		// Stored DECODED, which is what the mock does: the file is the JSON.
		assert.deepEqual(calls.local, [['shop-limits', { retries: 3 }]]);
	});
});
