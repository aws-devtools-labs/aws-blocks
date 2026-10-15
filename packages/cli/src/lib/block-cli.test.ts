// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveBlockBin } from './block-cli.js';

describe('resolveBlockBin', () => {
	let appRoot: string;

	before(() => {
		// A fake Blocks app whose node_modules/.bin has the data block's bin.
		appRoot = mkdtempSync(join(tmpdir(), 'blocks-db-test-'));
		const binDir = join(appRoot, 'node_modules', '.bin');
		mkdirSync(binDir, { recursive: true });
		// On POSIX the bin is a bare file; on Windows it is a .cmd shim. Stage
		// the platform-correct name so the probe matches what resolveBlockBin looks for.
		const binName = process.platform === 'win32' ? 'bb-data.cmd' : 'bb-data';
		writeFileSync(join(binDir, binName), '#!/usr/bin/env node\n');
	});

	after(() => {
		rmSync(appRoot, { recursive: true, force: true });
	});

	it('resolves an installed block bin from the app node_modules/.bin', () => {
		const resolved = resolveBlockBin('bb-data', appRoot);
		assert.ok(resolved, 'should find the installed bin');
		assert.ok(
			resolved!.includes(join('node_modules', '.bin')),
			'resolved path should be under node_modules/.bin',
		);
	});

	it('returns undefined when the block is not installed', () => {
		const resolved = resolveBlockBin('bb-nonexistent', appRoot);
		assert.strictEqual(resolved, undefined);
	});

	it('returns undefined when the project root has no node_modules', () => {
		const empty = mkdtempSync(join(tmpdir(), 'blocks-db-empty-'));
		try {
			assert.strictEqual(resolveBlockBin('bb-data', empty), undefined);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});
