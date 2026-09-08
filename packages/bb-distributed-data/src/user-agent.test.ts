// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { DistributedDatabase } from './index.aws.js';
import { BB_NAME, BB_VERSION } from './version.js';
import { CORE_VERSION } from '@aws-blocks/core/version';

/**
 * Integration tests that instantiate the REAL DistributedDatabase class and
 * verify the pg.Pool's `application_name` is configured correctly.
 *
 * DistributedDatabase lazily creates a DsqlEngine (and its pg.Pool) on first
 * access. We inject env vars so initialization succeeds, then call `getEngine()`
 * and inspect the pool's `application_name`.
 *
 * This directly tests the production code path:
 * DistributedDatabase → base getter → DsqlEngine({ applicationName }) →
 * pg.Pool({ application_name }).
 */

/** Helper: extract application_name from a real DistributedDatabase's pg.Pool */
function getApplicationName(dsql: DistributedDatabase): string | undefined {
	const engine = dsql.getEngine();
	return (engine as any).pool.options.application_name;
}

/** Set up env vars for the DSQL path so initialization succeeds */
function setEnvVars(fullId: string): void {
	const envName = fullId.replace(/[^a-zA-Z0-9]/g, '_');
	process.env[`BLOCKS_${envName}_ENDPOINT`] = 'test-cluster.dsql.us-east-1.on.aws';
	process.env[`BLOCKS_${envName}_REGION`] = 'us-east-1';
}

/** Clean up env vars after test */
function cleanEnvVars(fullId: string): void {
	const envName = fullId.replace(/[^a-zA-Z0-9]/g, '_');
	delete process.env[`BLOCKS_${envName}_ENDPOINT`];
	delete process.env[`BLOCKS_${envName}_REGION`];
}

/** A parent Building Block (simulates AuthBasic composing DistributedDatabase) */
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

describe('DistributedDatabase user-agent integration (DsqlEngine / pg.Pool application_name)', () => {
	test('standalone DistributedDatabase sets application_name on the pg.Pool', () => {
		const root = { id: 'my-app' };
		const fullId = 'my-app/dsql';
		setEnvVars(fullId);
		try {
			const dsql = new DistributedDatabase(root, 'dsql');
			const appName = getApplicationName(dsql);
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
			const appName = getApplicationName(dsql);
			assert.strictEqual(appName, `aws-blocks/${CORE_VERSION} bb/AuthBasic/1.0.1 bb/${BB_NAME}/${BB_VERSION}`);
		} finally {
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
			const appName = getApplicationName(dsql);
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
			const appName = getApplicationName(dsql);
			assert.ok(appName);
			assert.match(appName, /^aws-blocks\/\d+\.\d+\.\d+/);
			assert.match(appName, /bb\/DistributedDatabase\/\d+\.\d+\.\d+/);
		} finally {
			cleanEnvVars(fullId);
		}
	});
});
