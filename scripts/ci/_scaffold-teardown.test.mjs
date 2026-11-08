// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/ci/_scaffold-teardown.mjs, plus a check that the
// Windows E2E driver applies it before its production deploy.
//
// Run: node --test scripts/ci/_scaffold-teardown.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProductionDeployDisposable } from './_scaffold-teardown.mjs';

const repoFile = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const BACKEND_CDK_ENTRY = repoFile('packages/create-blocks-app/templates/backend/aws-blocks/index.cdk.ts');
const WINDOWS_DRIVER = readFileSync(repoFile('scripts/ci/windows-template-e2e.mjs'), 'utf-8');

const TMP = mkdtempSync(join(tmpdir(), 'scaffold-teardown-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const tmpFile = (name) => join(mkdtempSync(join(TMP, 'case-')), name);

const DISPOSABLE = '{ ...BlocksPresets.production, removalPolicy: cdk.RemovalPolicy.DESTROY, deletionProtection: false }';

describe('makeProductionDeployDisposable', () => {
	it('keeps the production preset but makes the backend template stack deletable', () => {
		const file = tmpFile('index.cdk.ts');
		copyFileSync(BACKEND_CDK_ENTRY, file);
		const original = readFileSync(file, 'utf-8');
		makeProductionDeployDisposable(file);
		const out = readFileSync(file, 'utf-8');
		assert.ok(out.includes(`defaults: sandboxMode ? BlocksPresets.sandbox : ${DISPOSABLE},`), out);
		assert.equal(out, original.replace('BlocksPresets.production', DISPOSABLE), 'only the preset expression changes');
	});

	it('throws, leaving the file as is, when the production preset is not used exactly once', () => {
		for (const source of [
			"import * as cdk from 'aws-cdk-lib';\nconst defaults = BlocksPresets.sandbox;\n",
			"import * as cdk from 'aws-cdk-lib';\nconst a = BlocksPresets.production; const b = BlocksPresets.production;\n",
		]) {
			const file = tmpFile('index.cdk.ts');
			writeFileSync(file, source);
			assert.throws(() => makeProductionDeployDisposable(file), /BlocksPresets\.production/);
			assert.equal(readFileSync(file, 'utf-8'), source);
		}
	});

	it('handles a CRLF checkout (Windows runners use autocrlf)', () => {
		const file = tmpFile('index.cdk.ts');
		writeFileSync(file, readFileSync(BACKEND_CDK_ENTRY, 'utf-8').replace(/\r?\n/g, '\r\n'));
		makeProductionDeployDisposable(file);
		assert.ok(readFileSync(file, 'utf-8').includes(`: ${DISPOSABLE},\r\n`));
	});

	it('throws when the entry does not import cdk', () => {
		const file = tmpFile('index.cdk.ts');
		writeFileSync(file, 'const defaults = BlocksPresets.production;\n');
		assert.throws(() => makeProductionDeployDisposable(file), /aws-cdk-lib/);
	});
});

describe('Windows E2E driver', () => {
	it('makes the scaffold disposable before anything is deployed', () => {
		const call = WINDOWS_DRIVER.match(/^ {2}makeProductionDeployDisposable\(join\(app, 'aws-blocks', 'index\.cdk\.ts'\)\);$/m);
		assert.ok(call, 'windows-template-e2e.mjs must call makeProductionDeployDisposable on the scaffold');
		for (const phase of ["['run', 'sandbox']", "['run', 'deploy']"]) {
			assert.ok(call.index < WINDOWS_DRIVER.indexOf(phase), `it must run before ${phase}`);
		}
	});
});
