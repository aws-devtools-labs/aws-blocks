// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { buildDashboardUrl, parseDashboardArgs, resolveAdminUi } from './dashboard.js';

describe('parseDashboardArgs', () => {
	it('defaults to open with no port', () => {
		assert.deepStrictEqual(parseDashboardArgs([]), { command: 'serve', open: true, json: false });
	});

	it('parses --no-open', () => {
		assert.deepStrictEqual(parseDashboardArgs(['--no-open']), { command: 'serve', open: false, json: false });
	});

	it('parses --port with a separate value', () => {
		assert.deepStrictEqual(parseDashboardArgs(['--port', '5000']), {
			command: 'serve',
			open: true,
			json: false,
			port: 5000,
		});
	});

	it('parses --port=<n>', () => {
		assert.deepStrictEqual(parseDashboardArgs(['--port=5001', '--no-open']), {
			command: 'serve',
			open: false,
			json: false,
			port: 5001,
		});
	});

	it('rejects invalid ports', () => {
		assert.throws(() => parseDashboardArgs(['--port', 'abc']), /Invalid --port/);
		assert.throws(() => parseDashboardArgs(['--port', '0']), /Invalid --port/);
		assert.throws(() => parseDashboardArgs(['--port', '70000']), /Invalid --port/);
		assert.throws(() => parseDashboardArgs(['--port']), /Invalid --port/);
	});
});

describe('parseDashboardArgs — subcommands', () => {
	it('defaults to the serve command', () => {
		assert.strictEqual(parseDashboardArgs([]).command, 'serve');
		assert.strictEqual(parseDashboardArgs(['--no-open']).command, 'serve');
	});

	it('parses the doctor subcommand', () => {
		assert.deepStrictEqual(parseDashboardArgs(['doctor']), { command: 'doctor', open: true, json: false });
	});

	it('parses an explicit serve subcommand', () => {
		assert.deepStrictEqual(parseDashboardArgs(['serve']), { command: 'serve', open: true, json: false });
	});

	it('parses flags after a subcommand', () => {
		assert.deepStrictEqual(parseDashboardArgs(['doctor', '--json', '--port=4500']), {
			command: 'doctor',
			open: true,
			json: true,
			port: 4500,
		});
	});

	it('throws on an unknown subcommand', () => {
		assert.throws(
			() => parseDashboardArgs(['diagnose']),
			/^Error: Unknown dashboard command: diagnose\. Expected "serve" or "doctor"\.$/,
		);
	});

	it('only treats position 0 as a subcommand', () => {
		// 'doctor' here is the value of --profile, not a second subcommand.
		assert.strictEqual(parseDashboardArgs(['--profile', 'doctor']).command, 'serve');
		assert.strictEqual(parseDashboardArgs(['--profile', 'doctor']).profile, 'doctor');
	});
});

describe('parseDashboardArgs — --json', () => {
	it('defaults to false and is set by --json', () => {
		assert.strictEqual(parseDashboardArgs([]).json, false);
		assert.strictEqual(parseDashboardArgs(['--json']).json, true);
		assert.strictEqual(parseDashboardArgs(['doctor', '--json']).json, true);
	});
});

describe('parseDashboardArgs — string flags', () => {
	it('parses --profile in both forms', () => {
		assert.strictEqual(parseDashboardArgs(['--profile', 'dev']).profile, 'dev');
		assert.strictEqual(parseDashboardArgs(['--profile=dev']).profile, 'dev');
	});

	it('parses --region in both forms', () => {
		assert.strictEqual(parseDashboardArgs(['--region', 'eu-west-1']).region, 'eu-west-1');
		assert.strictEqual(parseDashboardArgs(['--region=eu-west-1']).region, 'eu-west-1');
	});

	it('parses --project in both forms', () => {
		assert.strictEqual(parseDashboardArgs(['--project', '/apps/shop']).project, '/apps/shop');
		assert.strictEqual(parseDashboardArgs(['--project=/apps/shop']).project, '/apps/shop');
	});

	it('parses --allow-origin in both forms', () => {
		assert.deepStrictEqual(parseDashboardArgs(['--allow-origin', 'https://a.example']).allowOrigins, [
			'https://a.example',
		]);
		assert.deepStrictEqual(parseDashboardArgs(['--allow-origin=https://a.example']).allowOrigins, [
			'https://a.example',
		]);
	});

	it('collects a repeated --allow-origin, since one dashboard can sit behind two proxies', () => {
		assert.deepStrictEqual(
			parseDashboardArgs(['--allow-origin', 'https://a.example', '--allow-origin=https://b.example']).allowOrigins,
			['https://a.example', 'https://b.example'],
		);
	});

	it('leaves allowOrigins undefined when the flag is absent', () => {
		assert.strictEqual(parseDashboardArgs([]).allowOrigins, undefined);
	});

	it('rejects --allow-origin with no value', () => {
		assert.throws(() => parseDashboardArgs(['--allow-origin']), /Missing value for --allow-origin/);
		assert.throws(() => parseDashboardArgs(['--allow-origin', '--no-open']), /Missing value for --allow-origin/);
	});

	it('parses every flag together', () => {
		assert.deepStrictEqual(
			parseDashboardArgs([
				'doctor',
				'--profile=dev',
				'--region',
				'us-east-1',
				'--project=/apps/shop',
				'--json',
				'--no-open',
				'--port',
				'4401',
			]),
			{
				command: 'doctor',
				open: false,
				json: true,
				port: 4401,
				profile: 'dev',
				region: 'us-east-1',
				project: '/apps/shop',
			},
		);
	});

	it('throws when a flag is missing its value', () => {
		assert.throws(() => parseDashboardArgs(['--profile']), /Missing value for --profile/);
		assert.throws(() => parseDashboardArgs(['--region']), /Missing value for --region/);
		assert.throws(() => parseDashboardArgs(['--project']), /Missing value for --project/);
		assert.throws(() => parseDashboardArgs(['--profile=']), /Missing value for --profile/);
	});

	it('throws when a flag value looks like another flag', () => {
		assert.throws(() => parseDashboardArgs(['--profile', '--json']), /Missing value for --profile/);
		assert.throws(() => parseDashboardArgs(['--region', '--no-open']), /Missing value for --region/);
		assert.throws(() => parseDashboardArgs(['--project=-x']), /Missing value for --project/);
	});

	it('leaves unset string flags undefined', () => {
		const args = parseDashboardArgs(['--no-open']);
		assert.strictEqual(args.profile, undefined);
		assert.strictEqual(args.region, undefined);
		assert.strictEqual(args.project, undefined);
	});
});

describe('buildDashboardUrl', () => {
	it('puts the token in the URL fragment only', () => {
		const url = buildDashboardUrl('http://127.0.0.1:4400', 'abc123');
		assert.strictEqual(url, 'http://127.0.0.1:4400/#token=abc123');
	});
});

describe('resolveAdminUi', () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	it('fails with install instructions when admin-ui is missing and stdin is not a TTY', async () => {
		// node --test runs without a TTY, so the interactive prompt is skipped.
		tmpDir = join(tmpdir(), `dashboard-resolve-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'empty-app' }));
		await assert.rejects(() => resolveAdminUi(tmpDir), /npm install --save-dev @aws-blocks\/admin-ui/);
	});
});
