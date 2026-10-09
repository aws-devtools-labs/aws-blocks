// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';
import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { DistributedDatabase } from './index.aws.js';
import { BB_NAME, BB_VERSION } from './version.js';
import { CORE_VERSION } from '@aws-blocks/core/version';

/**
 * Drives the real DistributedDatabase class, not a mock. The chain goes in pg's
 * `fallback_application_name`, so these read the startup packet value
 * (`application_name || fallback_application_name`, pg/lib/client.js): the raw
 * pool option holds our value whether or not the server ever sees it.
 */

/**
 * The `application_name` pg would send in the startup packet, i.e. the setting
 * the server applies to the session. Constructing a Client resolves the
 * options without opening a socket; the pool builds its clients the same way
 * (`new this.Client(this.options)`).
 */
function effectiveApplicationName(dsql: DistributedDatabase): string | undefined {
	const engine = dsql.getEngine();
	const client = new pg.Client((engine as any).pool.options);
	return (client as any).getStartupConf().application_name;
}

/** The raw pool option, to pin which of pg's two slots the engine writes to. */
function poolOptions(dsql: DistributedDatabase): Record<string, unknown> {
	return (dsql.getEngine() as any).pool.options;
}

/** Set up env vars for the DSQL path so initialization succeeds */
function setEnvVars(fullId: string): void {
	const envName = fullId.replace(/[^a-zA-Z0-9]/g, '_');
	process.env[`BLOCKS_${envName}_ENDPOINT`] = 'test-cluster.dsql.us-east-1.on.aws';
	process.env[`BLOCKS_${envName}_REGION`] = 'us-east-1';
}

function cleanEnvVars(fullId: string): void {
	const envName = fullId.replace(/[^a-zA-Z0-9]/g, '_');
	delete process.env[`BLOCKS_${envName}_ENDPOINT`];
	delete process.env[`BLOCKS_${envName}_REGION`];
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

describe('DistributedDatabase user-agent integration (DsqlEngine / pg.Pool application_name)', () => {
	const originalEnv = { ...process.env };

	// pg reads PGAPPNAME into `application_name`, which outranks the fallback
	// slot, so an ambient value would mask the chain these tests assert.
	beforeEach(() => {
		delete process.env.PGAPPNAME;
	});
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	test('standalone DistributedDatabase reports the chain as application_name', () => {
		const root = { id: 'my-app' };
		const fullId = 'my-app/dsql';
		setEnvVars(fullId);
		try {
			const dsql = new DistributedDatabase(root, 'dsql');
			const appName = effectiveApplicationName(dsql);
			assert.strictEqual(appName, `aws-blocks/${CORE_VERSION} bb/${BB_NAME}/${BB_VERSION}`);
		} finally {
			cleanEnvVars(fullId);
		}
	});

	test('DistributedDatabase nested under AuthBasic includes parent BB in application_name', () => {
		const root = { id: 'my-app' };
		const auth = new ParentAuthBB(root, 'auth');
		const fullId = 'my-app/auth/dsql';
		setEnvVars(fullId);
		try {
			const dsql = new DistributedDatabase(auth, 'dsql');
			const appName = effectiveApplicationName(dsql);
			// `aws-blocks/<core> bb/AuthBasic/1.0.1 bb/DistributedDatabase/<ver>` is 64
			// bytes — one over the Postgres `application_name` limit (63). Left to the
			// server it would be clipped by byte count, mid-token; formatUserAgentString
			// elides the middle entry (the AuthBasic parent) instead.
			assert.ok(Buffer.byteLength(appName ?? '', 'utf8') <= 63);
			assert.strictEqual(appName, `aws-blocks/${CORE_VERSION} ... bb/${BB_NAME}/${BB_VERSION}`);
		} finally {
			cleanEnvVars(fullId);
		}
	});

	test('the chain is supplied in the fallback slot, not application_name', () => {
		const root = { id: 'my-app' };
		const fullId = 'my-app/dsql';
		setEnvVars(fullId);
		try {
			const options = poolOptions(new DistributedDatabase(root, 'dsql'));
			assert.strictEqual(
				options.fallback_application_name,
				`aws-blocks/${CORE_VERSION} bb/${BB_NAME}/${BB_VERSION}`,
			);
			assert.strictEqual(options.application_name, undefined, 'the overriding slot must be left free');
		} finally {
			cleanEnvVars(fullId);
		}
	});

	test("a caller's PGAPPNAME is not replaced", () => {
		const root = { id: 'my-app' };
		const fullId = 'my-app/dsql';
		setEnvVars(fullId);
		const saved = process.env.PGAPPNAME;
		process.env.PGAPPNAME = 'customer-env';
		try {
			const appName = effectiveApplicationName(new DistributedDatabase(root, 'dsql'));
			assert.strictEqual(appName, 'customer-env');
		} finally {
			if (saved === undefined) delete process.env.PGAPPNAME;
			else process.env.PGAPPNAME = saved;
			cleanEnvVars(fullId);
		}
	});

	test('custom (non-official) ancestor BB is excluded from application_name', () => {
		const root = { id: 'my-app' };
		const custom = new CustomParentBB(root, 'platform');
		const fullId = 'my-app/platform/dsql';
		setEnvVars(fullId);
		try {
			const dsql = new DistributedDatabase(custom, 'dsql');
			const appName = effectiveApplicationName(dsql);
			assert.strictEqual(appName, `aws-blocks/${CORE_VERSION} bb/${BB_NAME}/${BB_VERSION}`);
		} finally {
			cleanEnvVars(fullId);
		}
	});

	test('application_name matches the formatted buildUserAgentChain output', () => {
		const root = { id: 'root' };
		const fullId = 'root/dsql';
		setEnvVars(fullId);
		try {
			const dsql = new DistributedDatabase(root, 'dsql');
			const appName = effectiveApplicationName(dsql);
			assert.ok(appName);
			assert.match(appName, /^aws-blocks\/\d+\.\d+\.\d+/);
			assert.match(appName, /bb\/DistributedDatabase\/\d+\.\d+\.\d+/);
		} finally {
			cleanEnvVars(fullId);
		}
	});
});
