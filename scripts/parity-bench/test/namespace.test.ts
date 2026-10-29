// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the default-deny gate on the probe namespace.

import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import type { ParityCase } from '../src/core/types.js';
import { ApiError } from '@aws-blocks/core';
import { createProbeMethods } from '../src/server/namespace.js';

const CASE: ParityCase = {
	id: 'kv.item-size.store-put.small',
	pack: 'kv',
	block: 'bb-kv-store',
	category: 'limits',
	description: 'a small item',
	source: 'README',
	params: {},
};
const methods = createProbeMethods([CASE], { kv: async () => ({ outcome: { status: 'ok', value: 1 }, durationMs: 0, cleanup: 'ok' }) });
const saved = { probes: process.env.E2E_PARITY_PROBES, type: process.env.BLOCKS_DEPLOYMENT_TYPE };

afterEach(() => {
	for (const [key, value] of [['E2E_PARITY_PROBES', saved.probes], ['BLOCKS_DEPLOYMENT_TYPE', saved.type]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const notFound = (e: unknown) => e instanceof ApiError && e.status === 404;

test('probes answer 404 when the flag is unset', async () => {
	delete process.env.E2E_PARITY_PROBES;
	await assert.rejects(methods.listCases(), notFound);
	await assert.rejects(methods.run(CASE.id), notFound);
});

test('probes answer 404 on a production deployment even with the flag set', async () => {
	process.env.E2E_PARITY_PROBES = 'true';
	process.env.BLOCKS_DEPLOYMENT_TYPE = 'production';
	await assert.rejects(methods.listCases(), notFound);
	await assert.rejects(methods.run(CASE.id), notFound);
});

test('probes run on a sandbox deployment with the flag set', async () => {
	process.env.E2E_PARITY_PROBES = 'true';
	process.env.BLOCKS_DEPLOYMENT_TYPE = 'sandbox';
	assert.deepStrictEqual(await methods.listCases(), [CASE]);
	assert.strictEqual((await methods.run(CASE.id)).outcome.status, 'ok');
});
