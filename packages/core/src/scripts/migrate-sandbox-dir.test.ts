// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BLOCKS_SANDBOX_DIR, LEGACY_SANDBOX_DIR } from '../common/constants.js';
import { migrateLegacySandboxDir } from './migrate-sandbox-dir.js';
import { getSandboxId } from './stack-id.js';

/** A project root with `files` written into its pre-rename state directory. */
function appWithLegacyState(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'blocks-sandbox-migrate-'));
	const legacy = join(root, LEGACY_SANDBOX_DIR);
	mkdirSync(legacy, { recursive: true });
	for (const [name, body] of Object.entries(files)) writeFileSync(join(legacy, name), body);
	return root;
}

const read = (root: string, name: string): string => readFileSync(join(root, BLOCKS_SANDBOX_DIR, name), 'utf-8');

describe('sandbox state migration — copying an upgraded app forward across the directory rename', () => {
	it('copies the sandbox id forward, so an upgraded app keeps deploying to its own stack', () => {
		const root = appWithLegacyState({ 'sandbox-id.txt': 'alice-0d7e1c' });
		try {
			migrateLegacySandboxDir(root);
			assert.strictEqual(read(root, 'sandbox-id.txt'), 'alice-0d7e1c');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('leaves the legacy directory in place — it copies, never moves', () => {
		const root = appWithLegacyState({ 'sandbox-id.txt': 'alice-0d7e1c' });
		try {
			migrateLegacySandboxDir(root);
			assert.ok(
				existsSync(join(root, LEGACY_SANDBOX_DIR, 'sandbox-id.txt')),
				'the old file must survive for an older toolchain in the same checkout',
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('never overwrites the new location: state written since the upgrade wins', () => {
		const root = appWithLegacyState({ 'sandbox-id.txt': 'old-aaaaaa', 'outputs.json': '{"old":true}' });
		try {
			mkdirSync(join(root, BLOCKS_SANDBOX_DIR), { recursive: true });
			writeFileSync(join(root, BLOCKS_SANDBOX_DIR, 'sandbox-id.txt'), 'new-bbbbbb');
			migrateLegacySandboxDir(root);
			assert.strictEqual(read(root, 'sandbox-id.txt'), 'new-bbbbbb');
			// The file the new location did NOT have still comes across.
			assert.strictEqual(read(root, 'outputs.json'), '{"old":true}');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('copies each state file it finds and tolerates the ones an app never wrote', () => {
		const root = appWithLegacyState({
			'sandbox-id.txt': 'alice-0d7e1c',
			'config.json': '{"apiUrl":"http://localhost:3000/cdk-blocks/api"}',
			'config.sandbox.json': '{"apiUrl":"https://s.example"}',
			'config.production.json': '{"apiUrl":"https://p.example"}',
			'outputs.json': '{"s":{}}',
			'outputs.production.json': '{"p":{}}',
			'last-deploy.json': '{"stack":"demo"}',
			'dev-server.3000.pid': '{"pid":1}',
			'dev-server.4100.pid': '{"pid":2}',
		});
		try {
			migrateLegacySandboxDir(root);
			assert.deepStrictEqual(readdirSync(join(root, BLOCKS_SANDBOX_DIR)).sort(), [
				'config.json',
				'config.production.json',
				'config.sandbox.json',
				'dev-server.3000.pid',
				'dev-server.4100.pid',
				'last-deploy.json',
				'outputs.json',
				'outputs.production.json',
				'sandbox-id.txt',
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('migrates per file, never the directory: the CDK cloud assembly is left behind', () => {
		const root = appWithLegacyState({ 'sandbox-id.txt': 'alice-0d7e1c' });
		try {
			// The same directory doubles as the CDK output directory.
			mkdirSync(join(root, LEGACY_SANDBOX_DIR, 'cdk.out'), { recursive: true });
			writeFileSync(join(root, LEGACY_SANDBOX_DIR, 'cdk.out', 'manifest.json'), '{}');
			mkdirSync(join(root, LEGACY_SANDBOX_DIR, 'sandbox-destroy.out'), { recursive: true });
			writeFileSync(join(root, LEGACY_SANDBOX_DIR, 'tree.json'), '{}');

			migrateLegacySandboxDir(root);

			assert.deepStrictEqual(readdirSync(join(root, BLOCKS_SANDBOX_DIR)), ['sandbox-id.txt']);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('does nothing for an app that never had the old directory', () => {
		const root = mkdtempSync(join(tmpdir(), 'blocks-sandbox-migrate-'));
		try {
			migrateLegacySandboxDir(root);
			assert.ok(!existsSync(join(root, BLOCKS_SANDBOX_DIR)), 'a fresh app must not get an empty state directory');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('is idempotent: a second run copies nothing and does not throw', () => {
		const root = appWithLegacyState({ 'sandbox-id.txt': 'alice-0d7e1c' });
		try {
			migrateLegacySandboxDir(root);
			migrateLegacySandboxDir(root);
			assert.strictEqual(read(root, 'sandbox-id.txt'), 'alice-0d7e1c');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('fails loudly, naming the path and the orphaned stack, when the project directory is not writable', () => {
		const root = appWithLegacyState({ 'sandbox-id.txt': 'alice-0d7e1c' });
		try {
			chmodSync(root, 0o500);
			let writable = false;
			try {
				mkdirSync(join(root, BLOCKS_SANDBOX_DIR), { recursive: true });
				writable = true;
			} catch {
				// Expected: the read-only root is what this case needs.
			}
			if (writable) return; // running with privileges that ignore the mode — nothing to assert

			assert.throws(
				() => migrateLegacySandboxDir(root),
				(error: unknown) => {
					const message = (error as Error).message;
					assert.match(message, /Could not migrate this app's sandbox state/);
					assert.ok(message.includes(root), 'the message must name the path');
					assert.match(message, /NEW sandbox id/);
					assert.match(message, /standing in your account/);
					return true;
				},
			);
		} finally {
			chmodSync(root, 0o700);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('runs before getSandboxId can mint a new id, so an upgraded app is never sent to a different stack', () => {
		const root = appWithLegacyState({ 'sandbox-id.txt': 'alice-0d7e1c' });
		try {
			// getSandboxId is get-or-create: without the migration it would generate a new
			// id here, deploy to `<stackId>-<newId>`, and orphan the existing sandbox.
			assert.strictEqual(getSandboxId(root), 'alice-0d7e1c');
			assert.strictEqual(read(root, 'sandbox-id.txt'), 'alice-0d7e1c');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
