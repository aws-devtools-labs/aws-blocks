// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Covers the legacy `.blocks/config.json` fallback for stack scoping, whose absence
// fails silently: the secret and config prefixes answer an unresolved id with
// unscoped names. Uses the literal on-disk path so a mis-valued
// `LEGACY_BLOCKS_DIR` fails these tests.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getStackId } from './stack-id.js';

/** A project as it looks before the rename: only `.blocks/config.json`. */
function unrenamedApp(config: Record<string, unknown>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'unrenamed-app-')));
	mkdirSync(join(root, '.blocks'), { recursive: true });
	writeFileSync(join(root, '.blocks', 'config.json'), JSON.stringify(config));
	return root;
}

describe('an app that has not renamed its hidden folder', () => {
	const roots: string[] = [];
	const originalEnv = { ...process.env };
	let cwd: string;

	beforeEach(() => {
		cwd = process.cwd();
	});

	afterEach(() => {
		process.chdir(cwd);
		process.env = { ...originalEnv };
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});

	void it('resolves its stackId, so secret and config stay scoped to it', () => {
		const root = unrenamedApp({ stackId: 'unrenamed-app-k7x2mf' });
		roots.push(root);

		// Without the fallback this throws, and `blocksSecretPrefix` answers the
		// resulting unresolved id with the unscoped `/blocks/secrets` namespace.
		assert.equal(getStackId(root), 'unrenamed-app-k7x2mf');
	});

	// Telemetry creates `.cdk-blocks/config.json` holding only a projectId on the
	// first tracked command. Choosing the file by existence read that one, found no
	// stackId and threw, and `resolveStackId` in secret-naming.ts swallows the throw
	// and falls back to the unscoped `/blocks/secrets` namespace without a word.
	void it('resolves its stackId even after telemetry wrote the renamed config', () => {
		const root = unrenamedApp({ stackId: 'unrenamed-app-k7x2mf' });
		roots.push(root);
		mkdirSync(join(root, '.cdk-blocks'), { recursive: true });
		writeFileSync(join(root, '.cdk-blocks', 'config.json'), JSON.stringify({ telemetry: { projectId: 'p-1' } }));

		assert.equal(getStackId(root), 'unrenamed-app-k7x2mf');
	});

	void it('still fails loudly when neither folder holds a config', () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'no-config-app-')));
		roots.push(root);

		assert.throws(() => getStackId(root), /not found or missing stackId/);
	});
});
