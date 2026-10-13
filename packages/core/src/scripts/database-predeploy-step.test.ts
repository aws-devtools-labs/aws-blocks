// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildPredeployArgs, hasDatabasePackage, runDatabasePredeploy } from './database-predeploy-step.js';

test('buildPredeployArgs passes stage, project root and the optional app', () => {
	assert.deepStrictEqual(buildPredeployArgs({ stage: 'production', projectRoot: '/p' }), [
		'--no-install',
		'bb-database',
		'predeploy',
		'--stage',
		'production',
		'--project-root',
		'/p',
	]);
	assert.deepStrictEqual(buildPredeployArgs({ stage: 'sandbox', projectRoot: '/p', app: 'npx tsx x.ts' }).slice(-2), [
		'--app',
		'npx tsx x.ts',
	]);
});

test('a project without bb-database is skipped', () => {
	const dir = mkdtempSync(join(tmpdir(), 'core-predeploy-'));
	try {
		assert.strictEqual(hasDatabasePackage(dir), false);
		assert.strictEqual(runDatabasePredeploy({ stage: 'production', projectRoot: dir }), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
