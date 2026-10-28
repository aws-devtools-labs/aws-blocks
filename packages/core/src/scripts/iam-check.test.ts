// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { stubComputeFactory } from '../cdk/__fixtures__/stub-lambda-compute.js';
import { type BlocksDefaults, BlocksPresets } from '../cdk/blocks-defaults.js';
import { BlocksStack } from '../cdk/index.js';
import { checkCloudAssembly, IamCheckUsageError } from './iam-check.js';

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(__dirname, '..', 'cdk', '__fixtures__', name);
const cli = join(__dirname, 'iam-check-cli.js');

const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Synthesize a one-stack app into a fresh cloud assembly; returns its directory. */
async function synth(backend: string, defaults: BlocksDefaults, stackId = 'appa'): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), 'blocks-iam-check-'));
	dirs.push(dir);
	const app = new cdk.App({ outdir: dir });
	await BlocksStack.create(app, stackId, {
		backendHandlerPath: fixture('handler.js'),
		backendCDKPath: fixture(backend),
		defaults,
		defaultComputeFactory: stubComputeFactory,
	});
	app.synth();
	return dir;
}

const appDefaults: BlocksDefaults = { ...BlocksPresets.production, app: { id: 'appa' }, permissionsBoundary: 'apps-boundary' };

describe('blocks-iam-check', () => {
	test('a well-behaved app passes', async () => {
		const result = checkCloudAssembly(await synth('app-identity-backend.js', appDefaults), 'appa');
		assert.deepStrictEqual(result.violations, []);
		assert.deepStrictEqual(result.appIds, ['appa']);
		assert.ok(result.templates.length >= 1);
	});

	test('an overreaching app fails, from the templates as well as the report', async () => {
		const result = checkCloudAssembly(await synth('app-identity-violations-backend.js', appDefaults), 'appa');
		const fromTemplates = new Set(result.violations.filter((v) => v.source.endsWith('.template.json')).map((v) => v.rule));
		assert.deepStrictEqual([...fromTemplates].sort(), ['broad-managed-policy', 'grant-outside-app', 'wildcard-data-grant']);
	});

	test('a faked report (violations removed) still fails on the templates', async () => {
		const dir = await synth('app-identity-violations-backend.js', appDefaults);
		const file = join(dir, 'appa.blocks-iam.json');
		const report = JSON.parse(readFileSync(file, 'utf8'));
		writeFileSync(file, JSON.stringify({ ...report, violations: [] }));
		const rules = new Set(checkCloudAssembly(dir, 'appa').violations.map((v) => v.rule));
		assert.ok(rules.has('grant-outside-app'), [...rules].join(', '));
	});

	test('an app that claims another id fails', async () => {
		const dir = await synth('app-identity-backend.js', appDefaults);
		const rules = new Set(checkCloudAssembly(dir, 'appb').violations.map((v) => v.rule));
		for (const rule of ['app-id-mismatch', 'role-tag-mismatch', 'stack-tag-mismatch', 'stack-name-outside-app']) {
			assert.ok(rules.has(rule as never), `${rule} missing from ${[...rules].join(', ')}`);
		}
	});

	test('an app without defaults.app fails, and every role is reported unbounded and untagged', async () => {
		const dir = await synth('app-identity-backend.js', BlocksPresets.production);
		const rules = new Set(checkCloudAssembly(dir, 'appa').violations.map((v) => v.rule));
		for (const rule of ['app-id-mismatch', 'role-without-boundary', 'role-tag-mismatch']) {
			assert.ok(rules.has(rule as never), `${rule} missing from ${[...rules].join(', ')}`);
		}
	});

	test('no cloud assembly / no report: a usage error', async () => {
		const empty = mkdtempSync(join(tmpdir(), 'blocks-iam-check-empty-'));
		dirs.push(empty);
		assert.throws(() => checkCloudAssembly(empty), IamCheckUsageError);
		writeFileSync(join(empty, 'manifest.json'), '{"artifacts":{}}');
		assert.throws(() => checkCloudAssembly(empty), /no AWS Blocks IAM report/);
	});

	test('the CLI exits 0 when clean, 1 on violations, 2 on a usage error', async () => {
		const clean = await synth('app-identity-backend.js', appDefaults);
		const bad = await synth('app-identity-violations-backend.js', appDefaults);
		const run = (args: string[]) => {
			try {
				execFileSync(process.execPath, [cli, ...args], { stdio: 'pipe' });
				return 0;
			} catch (error) {
				return (error as { status?: number }).status;
			}
		};
		assert.strictEqual(run([clean, '--app', 'appa']), 0);
		assert.strictEqual(run([bad, '--app', 'appa']), 1);
		assert.strictEqual(run([clean, '--app']), 2);
	});
});
