// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseErrors } from '../errors.js';
import { DataApiEngine } from './data-api-engine.js';

// Table-driven classification test over the RDS Data API error corpus in
// test/fixtures/data-api-errors/. Each fixture is a real-shaped error `name` +
// `message`; we drive it through the real DataApiEngine.execute path (which
// rewrites error.name via translateError) and assert the resulting name.
//
// Why go through the engine rather than call translateError directly: the
// engine is the only thing customers and the migration Lambda ever see, and it
// rewrites error.name on the way out. Asserting on a hand-built error would not
// prove the classification a caller actually observes.
//
// See test/fixtures/data-api-errors/README.md for the fixture format and for
// how to regenerate the corpus from a live cluster.

interface ErrorFixture {
	name: string;
	message: string;
	expected: keyof typeof DatabaseErrors;
	provenance: string;
}

// dist/engines/*.test.js → package root → test/fixtures/data-api-errors
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/data-api-errors');

const loadFixtures = (): { file: string; fixture: ErrorFixture }[] =>
	readdirSync(FIXTURES_DIR)
		// Only promoted fixtures — `*.captured.json` are raw capture artifacts kept
		// for manual review before promotion (see README).
		.filter((f) => f.endsWith('.json') && !f.endsWith('.captured.json'))
		.map((file) => ({
			file,
			fixture: JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf-8')) as ErrorFixture,
		}));

/** Drive a fixture error through the real engine and return the classified error. */
const classifyThroughEngine = async (fixture: ErrorFixture): Promise<Error> => {
	const engine = new DataApiEngine({
		resourceArn: 'arn:cluster',
		secretArn: 'arn:secret',
		database: 'testdb',
		client: {
			send() {
				const err = new Error(fixture.message);
				err.name = fixture.name;
				return Promise.reject(err);
			},
		} as unknown as ConstructorParameters<typeof DataApiEngine>[0]['client'],
	});
	try {
		await engine.execute('CREATE TABLE IF NOT EXISTS _fixture_probe (id SERIAL PRIMARY KEY)');
	} catch (e) {
		return e as Error;
	}
	throw new Error(`fixture ${fixture.name} did not throw`);
};

const fixtures = loadFixtures();

test('the fixture corpus is non-empty', () => {
	assert.ok(fixtures.length > 0, `no fixtures found in ${FIXTURES_DIR}`);
});

for (const { file, fixture } of fixtures) {
	test(`${file}: ${fixture.name} → ${fixture.expected}`, async () => {
		const expectedName = DatabaseErrors[fixture.expected];
		assert.ok(expectedName, `fixture ${file} has unknown expected key "${fixture.expected}"`);
		const classified = await classifyThroughEngine(fixture);
		assert.strictEqual(
			classified.name,
			expectedName,
			`${file} (${fixture.provenance}) classified as ${classified.name}, expected ${expectedName}`,
		);
	});
}
