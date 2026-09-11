// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { Database } from './index.aws.js';
import { BB_NAME, BB_VERSION } from './version.js';
import { CORE_VERSION } from '@aws-blocks/core/version';

/**
 * Integration tests that instantiate the REAL Database class and verify
 * the RDS Data API client's customUserAgent is configured correctly.
 *
 * The Database lazily creates the DataApiEngine (and its RDSDataClient)
 * on first use. We inject env vars so the Aurora Data API path is taken,
 * then call `getEngine()` to trigger initialization and inspect the
 * resulting client's config.
 *
 * This directly tests the production code path:
 * Database constructor → resolveBase() → createDataApiEngine() →
 * buildUserAgentChain() → RDSDataClient config.
 */

/** Helper: extract customUserAgent from a real Database instance's RDSDataClient */
async function getCustomUserAgent(db: Database): Promise<[string, string][]> {
	const engine = await db.getEngine();
	return (engine as any).client.config.customUserAgent;
}

/** Set up env vars for the Aurora Data API path so initialization succeeds */
function setEnvVars(fullId: string): void {
	const envName = fullId.replace(/[^a-zA-Z0-9]/g, '_');
	process.env[`BLOCKS_${envName}_CLUSTER_ARN`] = 'arn:aws:rds:us-east-1:123456789012:cluster:test';
	process.env[`BLOCKS_${envName}_SECRET_ARN`] = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test';
	process.env[`BLOCKS_${envName}_DATABASE`] = 'testdb';
}

/** Clean up env vars after test */
function cleanEnvVars(fullId: string): void {
	const envName = fullId.replace(/[^a-zA-Z0-9]/g, '_');
	delete process.env[`BLOCKS_${envName}_CLUSTER_ARN`];
	delete process.env[`BLOCKS_${envName}_SECRET_ARN`];
	delete process.env[`BLOCKS_${envName}_DATABASE`];
}

/** A parent Building Block (simulates AuthBasic composing Database) */
class ParentAuthBB extends Scope {
	constructor(parent: ScopeParent, id: string) {
		super(id, { parent, bbName: 'AuthBasic', bbVersion: '1.0.1' });
	}
}

/** A custom (non-official) parent BB — its name must never appear in user-agent telemetry */
class CustomParentBB extends Scope {
	constructor(parent: ScopeParent, id: string) {
		super(id, { parent, bbName: 'Platform', bbVersion: '2.0.0' });
	}
}

describe('Database user-agent integration (real Database, Data API path)', () => {
	test('standalone Database configures RDSDataClient with correct customUserAgent', async () => {
		const root = { id: 'my-app' };
		const fullId = 'my-app/db';
		setEnvVars(fullId);
		try {
			const db = new Database(root, 'db');
			const ua = await getCustomUserAgent(db);
			assert.deepStrictEqual(ua, [
				['aws-blocks', CORE_VERSION],
				['bb', `${BB_NAME}/${BB_VERSION}`],
			]);
		} finally {
			cleanEnvVars(fullId);
		}
	});

	test('Database nested under AuthBasic includes parent BB in customUserAgent', async () => {
		const root = { id: 'my-app' };
		const auth = new ParentAuthBB(root, 'auth');
		const fullId = 'my-app/auth/db';
		setEnvVars(fullId);
		try {
			const db = new Database(auth, 'db');
			const ua = await getCustomUserAgent(db);
			assert.deepStrictEqual(ua, [
				['aws-blocks', CORE_VERSION],
				['bb', 'AuthBasic/1.0.1'],
				['bb', `${BB_NAME}/${BB_VERSION}`],
			]);
		} finally {
			cleanEnvVars(fullId);
		}
	});

	test('custom (non-official) ancestor BB is excluded from the user-agent chain', async () => {
		const root = { id: 'my-app' };
		const custom = new CustomParentBB(root, 'platform');
		const fullId = 'my-app/platform/db';
		setEnvVars(fullId);
		try {
			const db = new Database(custom, 'db');
			const ua = await getCustomUserAgent(db);
			assert.deepStrictEqual(ua, [
				['aws-blocks', CORE_VERSION],
				['bb', `${BB_NAME}/${BB_VERSION}`],
			]);
		} finally {
			cleanEnvVars(fullId);
		}
	});

	test('customUserAgent values match the generated version constants', async () => {
		const root = { id: 'root' };
		const fullId = 'root/db';
		setEnvVars(fullId);
		try {
			const db = new Database(root, 'db');
			const ua = await getCustomUserAgent(db);
			const [awsBlocksEntry, bbEntry] = ua;

			assert.strictEqual(awsBlocksEntry[0], 'aws-blocks');
			assert.strictEqual(awsBlocksEntry[1], CORE_VERSION);
			assert.strictEqual(bbEntry[0], 'bb');
			assert.strictEqual(bbEntry[1], `Database/${BB_VERSION}`);

			// Verify these are real semver strings (not empty or undefined)
			assert.match(CORE_VERSION, /^\d+\.\d+\.\d+/);
			assert.match(BB_VERSION, /^\d+\.\d+\.\d+/);
			assert.strictEqual(BB_NAME, 'Database');
		} finally {
			cleanEnvVars(fullId);
		}
	});
});


/**
 * PgClientEngine path (fromExisting with connectionString).
 *
 * When a Database is configured with a connectionString, it creates a
 * PgClientEngine backed by pg.Pool. The application_name pool option
 * propagates the BB user-agent chain to pg_stat_activity on the server.
 *
 * We access `(engine).pool.options.application_name` to verify the
 * production code path: Database → _initBase() → buildUserAgentChain() →
 * PgClientEngine({ applicationName }) → pg.Pool({ application_name }).
 */
describe('Database user-agent integration (PgClientEngine / connectionString path)', () => {
	const CONN = 'postgres://u:p@db.example.com:5432/postgres';

	/** Helper: extract application_name from the pg.Pool backing a Database instance */
	async function getApplicationName(db: Database): Promise<string | undefined> {
		const engine = await db.getEngine();
		return (engine as any).pool.options.application_name;
	}

	test('standalone Database sets application_name on the pg.Pool', async () => {
		const root = { id: 'my-app' };
		const db = new Database(root, 'db', { connection: { connectionString: CONN } });

		const appName = await getApplicationName(db);
		assert.strictEqual(appName, `aws-blocks/${CORE_VERSION} bb/${BB_NAME}/${BB_VERSION}`);
	});

	test('Database nested under AuthBasic includes parent BB in application_name', async () => {
		const root = { id: 'my-app' };
		const auth = new ParentAuthBB(root, 'auth');
		const db = new Database(auth, 'db', { connection: { connectionString: CONN } });

		const appName = await getApplicationName(db);
		assert.strictEqual(appName, `aws-blocks/${CORE_VERSION} bb/AuthBasic/1.0.1 bb/${BB_NAME}/${BB_VERSION}`);
	});

	test('custom (non-official) ancestor BB is excluded from application_name', async () => {
		const root = { id: 'my-app' };
		const custom = new CustomParentBB(root, 'platform');
		const db = new Database(custom, 'db', { connection: { connectionString: CONN } });

		const appName = await getApplicationName(db);
		assert.strictEqual(appName, `aws-blocks/${CORE_VERSION} bb/${BB_NAME}/${BB_VERSION}`);
	});

	test('application_name matches the formatted buildUserAgentChain output', async () => {
		const root = { id: 'root' };
		const db = new Database(root, 'db', { connection: { connectionString: CONN } });

		const appName = await getApplicationName(db);
		assert.ok(appName);
		// Must start with aws-blocks and include the BB entry
		assert.match(appName, /^aws-blocks\/\d+\.\d+\.\d+/);
		assert.match(appName, /bb\/Database\/\d+\.\d+\.\d+/);
	});
});
