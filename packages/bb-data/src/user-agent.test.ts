// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';
import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { Database } from './index.aws.js';
import { BB_NAME, BB_VERSION } from './version.js';
import { CORE_VERSION } from '@aws-blocks/core/version';

/**
 * Drives the real Database class, not a mock, so the assertions cover the
 * production path end to end.
 */

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

function cleanEnvVars(fullId: string): void {
	const envName = fullId.replace(/[^a-zA-Z0-9]/g, '_');
	delete process.env[`BLOCKS_${envName}_CLUSTER_ARN`];
	delete process.env[`BLOCKS_${envName}_SECRET_ARN`];
	delete process.env[`BLOCKS_${envName}_DATABASE`];
}

class ParentAuthBB extends Scope {
	constructor(parent: ScopeParent, id: string) {
		super(id, { parent, bbName: 'AuthBasic', bbVersion: '1.0.1' });
	}
}

/** A custom (non-official) parent BB; its name must never reach the user agent. */
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

			assert.match(CORE_VERSION, /^\d+\.\d+\.\d+/);
			assert.match(BB_VERSION, /^\d+\.\d+\.\d+/);
			assert.strictEqual(BB_NAME, 'Database');
		} finally {
			cleanEnvVars(fullId);
		}
	});
});


/**
 * The chain goes in pg's `fallback_application_name`, so these read the startup
 * packet value (`application_name || fallback_application_name`,
 * pg/lib/client.js): the raw pool option holds our value either way and would
 * pass even when the server never sees it.
 */
describe('Database user-agent integration (PgClientEngine / connectionString path)', () => {
	const CONN = 'postgres://u:p@db.example.com:5432/postgres';
	const originalEnv = { ...process.env };

	// pg reads PGAPPNAME into `application_name`, which outranks the fallback
	// slot, so an ambient value would mask the chain these tests assert.
	beforeEach(() => {
		delete process.env.PGAPPNAME;
	});
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	/**
	 * The `application_name` pg would send in the startup packet, i.e. the setting
	 * the server applies to the session. Constructing a Client resolves the
	 * connection string against the explicit options without opening a socket;
	 * the pool builds its clients the same way (`new this.Client(this.options)`).
	 */
	async function effectiveApplicationName(db: Database): Promise<string | undefined> {
		const engine = await db.getEngine();
		const client = new pg.Client((engine as any).pool.options);
		return (client as any).getStartupConf().application_name;
	}

	/** The raw pool option, to pin which of pg's two slots the engine writes to. */
	async function poolOptions(db: Database): Promise<Record<string, unknown>> {
		const engine = await db.getEngine();
		return (engine as any).pool.options;
	}

	test('standalone Database reports the chain as application_name', async () => {
		const root = { id: 'my-app' };
		const db = new Database(root, 'db', { connection: { connectionString: CONN } });

		const appName = await effectiveApplicationName(db);
		assert.strictEqual(appName, `aws-blocks/${CORE_VERSION} bb/${BB_NAME}/${BB_VERSION}`);
	});

	test('the chain is supplied in the fallback slot, not application_name', async () => {
		const root = { id: 'my-app' };
		const db = new Database(root, 'db', { connection: { connectionString: CONN } });

		const options = await poolOptions(db);
		assert.strictEqual(
			options.fallback_application_name,
			`aws-blocks/${CORE_VERSION} bb/${BB_NAME}/${BB_VERSION}`,
		);
		assert.strictEqual(options.application_name, undefined, 'the overriding slot must be left free');
	});

	test("a caller's own application_name in the connection string is not replaced", async () => {
		const root = { id: 'my-app' };
		const db = new Database(root, 'db', {
			connection: { connectionString: `${CONN}?application_name=customer-app` },
		});

		const appName = await effectiveApplicationName(db);
		assert.strictEqual(appName, 'customer-app');
	});

	test("a caller's PGAPPNAME is not replaced", async () => {
		const root = { id: 'my-app' };
		const saved = process.env.PGAPPNAME;
		process.env.PGAPPNAME = 'customer-env';
		try {
			const db = new Database(root, 'db', { connection: { connectionString: CONN } });

			const appName = await effectiveApplicationName(db);
			assert.strictEqual(appName, 'customer-env');
		} finally {
			if (saved === undefined) delete process.env.PGAPPNAME;
			else process.env.PGAPPNAME = saved;
		}
	});

	test('Database nested under AuthBasic includes parent BB in application_name', async () => {
		const root = { id: 'my-app' };
		const auth = new ParentAuthBB(root, 'auth');
		const db = new Database(auth, 'db', { connection: { connectionString: CONN } });

		const appName = await effectiveApplicationName(db);
		assert.strictEqual(appName, `aws-blocks/${CORE_VERSION} bb/AuthBasic/1.0.1 bb/${BB_NAME}/${BB_VERSION}`);
	});

	test('custom (non-official) ancestor BB is excluded from application_name', async () => {
		const root = { id: 'my-app' };
		const custom = new CustomParentBB(root, 'platform');
		const db = new Database(custom, 'db', { connection: { connectionString: CONN } });

		const appName = await effectiveApplicationName(db);
		assert.strictEqual(appName, `aws-blocks/${CORE_VERSION} bb/${BB_NAME}/${BB_VERSION}`);
	});

	test('application_name matches the formatted buildUserAgentChain output', async () => {
		const root = { id: 'root' };
		const db = new Database(root, 'db', { connection: { connectionString: CONN } });

		const appName = await effectiveApplicationName(db);
		assert.ok(appName);
		assert.match(appName, /^aws-blocks\/\d+\.\d+\.\d+/);
		assert.match(appName, /bb\/Database\/\d+\.\d+\.\d+/);
	});
});
