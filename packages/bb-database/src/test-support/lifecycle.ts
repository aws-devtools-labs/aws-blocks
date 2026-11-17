// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The per-process state the block keeps, reset the same way by every test file that constructs blocks.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach } from 'node:test';
import { Scope } from '@aws-blocks/core';
import { _closeAllPgliteClusters } from '../engines/pglite-cluster.js';
import { _resetDatabaseRegistry } from '../runtime/construction.js';
import { removeFixtures } from './fixtures.js';

const MOCK_DATA_ROOT = join(process.cwd(), '.bb-data');

let scopes = 0;

/** `{prefix}-{pid}-{name}`: the id of a scope this process alone uses, the same one on every call with `name`. */
export function scopeId(prefix: string, name: string | number): string {
	return `${prefix}-${process.pid}-${name}`;
}

/**
 * A `Scope` whose id no other test in this process uses, so its blocks get their own registry entries and data
 * dir. `create` builds another kind of scope from the id (the CDK one).
 */
export function freshScope(prefix: string): Scope;
export function freshScope<S>(prefix: string, create: (id: string) => S): S;
export function freshScope(prefix: string, create: (id: string) => unknown = (id) => new Scope(id)): unknown {
	return create(scopeId(prefix, ++scopes));
}

interface LocalTestHooks {
	/**
	 * The `scopeId()` prefix of every block the file constructs. Its data under `.bb-data/` is removed once, at
	 * the end; test files run in parallel, so a file removes only what it wrote.
	 */
	mockDataPrefix?: string;
}

/**
 * Resets the block's registries before every test; after the last one closes every local PGlite and removes
 * the file's mock data and fixture directories. Call once at the top of a test file.
 */
export function installLocalTestHooks(options: LocalTestHooks = {}): void {
	beforeEach(() => {
		_resetDatabaseRegistry();
		Scope._resetRegistry();
	});
	after(async () => {
		await _closeAllPgliteClusters();
		if (options.mockDataPrefix !== undefined) removeMockData(`${options.mockDataPrefix}-${process.pid}`);
		removeFixtures();
	});
}

function removeMockData(prefix: string): void {
	if (!existsSync(MOCK_DATA_ROOT)) return;
	for (const entry of readdirSync(MOCK_DATA_ROOT)) {
		if (entry.startsWith(prefix)) rmSync(join(MOCK_DATA_ROOT, entry), { recursive: true, force: true });
	}
}
