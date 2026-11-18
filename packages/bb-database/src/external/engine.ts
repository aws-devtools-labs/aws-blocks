// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { searchPathFor } from '../constants.js';
import { PgEngine } from '../engines/pg-engine.js';
import type { ConnectionStringSource } from '../types.js';
import { parseConnectionString } from './connection.js';

export interface ExternalEngineOptions {
	/** Where the connection string is read from. */
	source: ConnectionStringSource;
	/** What an error calls that place; never the value. */
	label: string;
	ca?: string;
	schemaName: string;
	poolSize?: number;
}

/**
 * The engine of a block on an existing database, for the local entry, the Lambda entry, the migration function
 * and the CLI: read the stored value once, split it into fields, and open a verified pool.
 */
export async function externalEngine(options: ExternalEngineOptions): Promise<PgEngine> {
	const connection = parseConnectionString(await options.source.get(), options.label);
	return new PgEngine({
		kind: 'external',
		connection,
		ca: options.ca,
		searchPath: searchPathFor(options.schemaName),
		poolSize: options.poolSize,
	});
}
