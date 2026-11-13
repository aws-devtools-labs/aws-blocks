// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { isBlocksError, Scope } from '@aws-blocks/core';
import {
	CreateTableCommand,
	DeleteTableCommand,
	DynamoDBClient,
	GetItemCommand,
	ResourceNotFoundException,
	waitUntilTableExists,
	waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadSharedConfigFiles } from '@smithy/core/config';
import { KVStore, KVStoreErrors } from './index.aws.js';

function emulatorEndpoint(value: string): URL {
	const endpoint = new URL(value);
	assert.equal(endpoint.protocol, 'https:', 'Use the HTTPS endpoint of the local emulator');
	assert.ok(
		['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname),
		'BLOCKS_TEST_AWS_ENDPOINT must point to a loopback emulator, not AWS',
	);
	assert.ok(!endpoint.username && !endpoint.password, 'Do not put credentials in the endpoint URL');
	assert.equal(endpoint.pathname, '/', 'The emulator endpoint must not include a path');
	assert.ok(!endpoint.search && !endpoint.hash, 'The emulator endpoint must not include a query or fragment');
	return endpoint;
}

function assertEmulatorRequest(request: unknown, endpoint: URL): void {
	assert.ok(typeof request === 'object' && request !== null);
	assert.ok('hostname' in request && 'protocol' in request);
	assert.ok(
		request.hostname === endpoint.hostname || `[${String(request.hostname)}]` === endpoint.hostname,
		'The SDK must send every request to the configured emulator',
	);
	assert.equal(request.protocol, 'https:');
	const port = 'port' in request ? request.port : undefined;
	assert.equal(Number(port ?? 443), Number(endpoint.port || 443));
}

describe('emulator endpoint safety', () => {
	test('accepts HTTPS loopback endpoints', () => {
		for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
			assert.equal(emulatorEndpoint(`https://${host}:9297`).port, '9297');
		}
	});

	test('rejects remote, non-HTTPS and credential-bearing endpoints', () => {
		for (const endpoint of [
			'https://dynamodb.us-east-1.amazonaws.com',
			'https://example.com:9297',
			'http://127.0.0.1:9297',
			'https://user:secret@127.0.0.1:9297',
			'https://127.0.0.1:9297/path',
			'https://127.0.0.1:9297?query=1',
			'https://127.0.0.1:9297#fragment',
		]) {
			assert.throws(() => emulatorEndpoint(endpoint));
		}
	});

	test('rejects an SDK request whose destination changed', () => {
		const endpoint = emulatorEndpoint('https://127.0.0.1:9297');
		assert.throws(() =>
			assertEmulatorRequest(
				{ hostname: 'dynamodb.us-east-1.amazonaws.com', protocol: 'https:', port: 443 },
				endpoint,
			),
		);
		assert.throws(() => assertEmulatorRequest({ hostname: '127.0.0.1', protocol: 'https:', port: 9300 }, endpoint));
		assertEmulatorRequest({ hostname: '127.0.0.1', protocol: 'https:', port: 9297 }, endpoint);
	});
});

const endpointValue = process.env.BLOCKS_TEST_AWS_ENDPOINT;

describe('KVStore AWS-runtime integration with AWS Emulator', {
	skip: !endpointValue && 'Set BLOCKS_TEST_AWS_ENDPOINT to enable the local emulator integration suite',
	timeout: 120_000,
}, () => {
	const tableName = `blocks-kv-emulator-${randomUUID()}`;
	const previousEnvironment = new Map<string, string | undefined>();
	let client: DynamoDBClient | undefined;
	let runtimeClient: DynamoDBDocumentClient | undefined;
	let store: KVStore<string>;
	let createAttempted = false;

	before(
		async () => {
			assert.ok(endpointValue);
			const endpoint = emulatorEndpoint(endpointValue);
			assert.notEqual(
				process.env.NODE_TLS_REJECT_UNAUTHORIZED,
				'0',
				'Keep HTTPS certificate verification enabled',
			);
			const credentialsFilepath = process.env.AWS_SHARED_CREDENTIALS_FILE;
			assert.ok(credentialsFilepath, 'Set AWS_SHARED_CREDENTIALS_FILE to the emulator_credentials file');
			assert.ok(
				process.env.NODE_EXTRA_CA_CERTS,
				'Set NODE_EXTRA_CA_CERTS to the emulator ca.pem before starting Node',
			);

			// Parse only the explicitly supplied file. Do not resolve a profile,
			// credential_process, SSO or an assume-role chain against real AWS.
			const files = await loadSharedConfigFiles({
				filepath: credentialsFilepath,
				configFilepath: credentialsFilepath,
				ignoreCache: true,
			});
			const credentials = files.credentialsFile.default;
			assert.ok(
				credentials?.aws_access_key_id,
				'The emulator_credentials file must contain a default access key',
			);
			assert.ok(
				credentials.aws_secret_access_key,
				'The emulator_credentials file must contain a default secret key',
			);
			const overrides: Record<string, string | undefined> = {
				AWS_ACCESS_KEY_ID: credentials.aws_access_key_id,
				AWS_SECRET_ACCESS_KEY: credentials.aws_secret_access_key,
				AWS_SESSION_TOKEN: credentials.aws_session_token,
				AWS_PROFILE: undefined,
				AWS_REGION: 'us-east-1',
				AWS_ENDPOINT_URL_DYNAMODB: endpoint.href,
				AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'false',
				AWS_EC2_METADATA_DISABLED: 'true',
				AWS_MAX_ATTEMPTS: '1',
			};
			for (const [name, value] of Object.entries(overrides)) {
				previousEnvironment.set(name, process.env[name]);
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}

			client = new DynamoDBClient({
				endpoint: endpoint.href,
				region: 'us-east-1',
				credentials: {
					accessKeyId: credentials.aws_access_key_id,
					secretAccessKey: credentials.aws_secret_access_key,
					sessionToken: credentials.aws_session_token,
				},
				maxAttempts: 1,
				requestHandler: { connectionTimeout: 2_000, requestTimeout: 10_000 },
			});
			client.middlewareStack.add(
				(next) => async (args) => {
					assertEmulatorRequest(args.request, endpoint);
					return next(args);
				},
				{ step: 'build', name: 'assertLocalEmulator' },
			);

			store = new KVStore(new Scope(tableName), 'store', { table: KVStore.fromExisting(tableName) });
			// White-box access is limited to checking destinations and closing the
			// transport. The real SDK sends every request and parses every response.
			runtimeClient = (store as unknown as { docClient: DynamoDBDocumentClient }).docClient;
			runtimeClient.middlewareStack.add(
				(next) => async (args) => {
					assertEmulatorRequest(args.request, endpoint);
					return next(args);
				},
				{ step: 'build', name: 'assertLocalEmulator' },
			);

			createAttempted = true;
			await client.send(
				new CreateTableCommand({
					TableName: tableName,
					AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
					KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
					BillingMode: 'PAY_PER_REQUEST',
				}),
			);
			await waitUntilTableExists({ client, maxWaitTime: 30, minDelay: 1, maxDelay: 1 }, { TableName: tableName });
		},
		{ timeout: 60_000 },
	);

	after(
		async () => {
			try {
				if (client && createAttempted) {
					try {
						await client.send(new DeleteTableCommand({ TableName: tableName }));
						await waitUntilTableNotExists(
							{ client, maxWaitTime: 30, minDelay: 1, maxDelay: 1 },
							{ TableName: tableName },
						);
					} catch (error) {
						if (!(error instanceof ResourceNotFoundException)) throw error;
					}
				}
			} finally {
				runtimeClient?.destroy();
				client?.destroy();
				for (const [name, value] of previousEnvironment) {
					if (value === undefined) delete process.env[name];
					else process.env[name] = value;
				}
			}
		},
		{ timeout: 45_000 },
	);

	test('writes and reads through the AWS runtime', { timeout: 20_000 }, async () => {
		await store.put('roundtrip', 'hello');
		assert.equal(await store.get('roundtrip'), 'hello');
	});

	test('maps a conditional conflict and leaves the stored value unchanged', { timeout: 20_000 }, async () => {
		await store.put('conditional', 'first');
		await assert.rejects(
			() => store.put('conditional', 'second', { ifNotExists: true }),
			(error) => {
				assert.ok(isBlocksError(error, KVStoreErrors.ConditionalCheckFailed));
				assert.ok(error instanceof Error && 'status' in error);
				assert.equal(error.status, 409);
				return true;
			},
		);
		assert.equal(await store.get('conditional'), 'first');
	});

	test('hides an expired item that is still physically present', { timeout: 20_000 }, async () => {
		const expiresAt = Math.floor(Date.now() / 1000) - 60;
		await store.put('expired', 'gone', { expiresAt });
		assert.ok(client);
		const raw = await client.send(
			new GetItemCommand({
				TableName: tableName,
				Key: { pk: { S: 'expired' } },
				ConsistentRead: true,
			}),
		);
		assert.ok(raw.Item, 'TTL cleanup was not enabled: the expired row must remain physically present');
		assert.equal(raw.Item.ttl?.N, String(expiresAt));
		assert.equal(await store.get('expired'), null);
	});

	test('maps a service-side oversized item error', { timeout: 20_000 }, async () => {
		await assert.rejects(
			() => store.put('oversized', 'x'.repeat(450 * 1024)),
			(error) => {
				assert.ok(isBlocksError(error, KVStoreErrors.ItemTooLarge));
				assert.ok(error instanceof Error && error.cause instanceof Error);
				assert.equal(error.cause.name, 'ValidationException');
				assert.match(error.cause.message, /size has exceeded/i);
				return true;
			},
		);
	});

	test('evaluates the OR-composed conditional write against stored data', { timeout: 20_000 }, async () => {
		await store.put('or', 'first', { ifNotExists: true, ifValueEquals: 'missing' });
		await store.put('or', 'second', { ifNotExists: true, ifValueEquals: 'first' });
		assert.equal(await store.get('or'), 'second');
		await assert.rejects(
			() => store.put('or', 'third', { ifNotExists: true, ifValueEquals: 'first' }),
			(error) => {
				assert.ok(isBlocksError(error, KVStoreErrors.ConditionalCheckFailed));
				return true;
			},
		);
	});

	test('deletes through the AWS runtime', { timeout: 20_000 }, async () => {
		await store.put('deleted', 'value');
		await store.delete('deleted');
		assert.equal(await store.get('deleted'), null);
	});
});
