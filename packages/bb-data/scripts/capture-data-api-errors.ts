// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Capture real RDS Data API error shapes from a live Aurora cluster into
 * test/fixtures/data-api-errors/*.captured.json, for review before promotion to
 * the classification corpus. See test/fixtures/data-api-errors/README.md.
 *
 * This is a manual, AWS-touching operations script — not part of the package
 * build or the test suite. Run it against a throwaway sandbox cluster:
 *
 *   RESOURCE_ARN=arn:aws:rds:REGION:ACCT:cluster:NAME \
 *   SECRET_ARN=arn:aws:secretsmanager:REGION:ACCT:secret:NAME \
 *   DATABASE=postgres \
 *   AWS_REGION=REGION \
 *   npx tsx scripts/capture-data-api-errors.ts
 *
 * Each probe runs a statement crafted to fail with a specific error class, then
 * records the raw `name`/`message` the SDK actually threw. It only reads and
 * writes fixture files; it does not create or drop real tables (every probe
 * targets a non-existent object or is syntactically invalid).
 *
 * The `database-resuming` probe only produces its error when the cluster is a
 * `minCapacity: 0` cluster that has been idle past its ~5-minute auto-pause
 * window. Idle the cluster (or scale it to 0 ACU) first, then run just that
 * probe; otherwise it will succeed or fail differently and should be skipped.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/data-api-errors');

const requireEnv = (key: string): string => {
	const value = process.env[key];
	if (!value) throw new Error(`Missing required env var ${key}`);
	return value;
};

// Statements crafted to provoke a specific error class. `expected` is the
// DatabaseErrors key we believe the engine should classify each as — recorded
// alongside the capture so a reviewer can confirm the mapping still holds.
const PROBES: { slug: string; sql: string; expected: string }[] = [
	{ slug: 'syntax-error', sql: 'CREAT TABLE bad_syntax (id int)', expected: 'QueryFailed' },
	{ slug: 'undefined-table', sql: 'SELECT * FROM definitely_missing_table_xyz', expected: 'QueryFailed' },
	{
		slug: 'unique-constraint',
		sql: "INSERT INTO pg_namespace (nspname) VALUES ('pg_catalog')",
		expected: 'UniqueConstraintViolation',
	},
];

const main = async (): Promise<void> => {
	const resourceArn = requireEnv('RESOURCE_ARN');
	const secretArn = requireEnv('SECRET_ARN');
	const database = requireEnv('DATABASE');
	const client = new RDSDataClient({});

	for (const probe of PROBES) {
		let captured: { name: string; message: string } | null = null;
		try {
			await client.send(new ExecuteStatementCommand({ resourceArn, secretArn, database, sql: probe.sql }));
			console.warn(`[capture] ${probe.slug}: statement unexpectedly succeeded — skipping`);
		} catch (e) {
			captured = {
				name: e instanceof Error ? e.name : 'unknown',
				message: e instanceof Error ? e.message : String(e),
			};
		}
		if (!captured) continue;
		const out = join(FIXTURES_DIR, `${probe.slug}.captured.json`);
		const record = {
			...captured,
			expected: probe.expected,
			provenance: `captured from live cluster ${new Date().toISOString()}`,
		};
		writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
		console.log(`[capture] ${probe.slug}: ${captured.name} → wrote ${out}`);
	}
};

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
