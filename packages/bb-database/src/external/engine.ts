// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { searchPathFor } from '../constants.js';
import { PgEngine } from '../engines/pg-engine.js';
import type { ConnectionStringSource } from '../types.js';
import { type ConnectionFields, parseConnectionString } from './connection.js';

export interface ExternalEngineOptions {
	ca?: string;
	schemaName: string;
	poolSize?: number;
}

/** The engine of a block on an existing database, from a connection string that is already split into fields. */
export function externalEngine(connection: ConnectionFields, options: ExternalEngineOptions): PgEngine {
	return new PgEngine({
		kind: 'external',
		connection,
		ca: options.ca,
		searchPath: searchPathFor(options.schemaName),
		poolSize: options.poolSize,
	});
}

/**
 * The same engine for the local entry and the Lambda entry: read the stored value once and split it. `label` is
 * what an error calls the place the value is read from; never the value.
 */
export async function externalEngineFrom(
	source: ConnectionStringSource,
	label: string,
	options: ExternalEngineOptions,
): Promise<PgEngine> {
	return externalEngine(parseConnectionString(await source.get(), label), options);
}
