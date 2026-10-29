// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// DSQL (bb-distributed-data) parity cases. Pure data — executed by dsql.probe.ts.

import type { ParityCase } from '../core/types.js';

export type DsqlMutationPath = 'execute' | 'query' | 'transaction' | 'transaction-query';

const PATH_LABEL: Record<DsqlMutationPath, string> = {
	execute: 'db.execute()',
	query: 'db.query() with RETURNING',
	transaction: 'tx.execute() inside db.transaction()',
	'transaction-query': 'tx.query() with RETURNING inside db.transaction()',
};

const DSQL_QUOTAS = 'https://docs.aws.amazon.com/aurora-dsql/latest/userguide/CHAP_quotas.html';

/** Aurora DSQL caps a transaction at 3,000 mutated rows: slide the row count on every mutation path. */
export const dsqlCases: readonly ParityCase[] = (['execute', 'query', 'transaction', 'transaction-query'] as const).map(
	(path): ParityCase => ({
		id: `dsql.row-limit.${path}`,
		pack: 'dsql',
		block: 'bb-distributed-data',
		category: 'limits',
		description: `UPDATE n rows in one statement via ${PATH_LABEL[path]}`,
		source: `${DSQL_QUOTAS} (3,000 rows mutated per transaction)`,
		params: { path, rows: 0 },
		sweep: { param: 'rows', min: 1, max: 10_000, unit: 'rows', documented: 3000 },
	}),
);
