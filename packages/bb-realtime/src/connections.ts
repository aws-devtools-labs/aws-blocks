// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The connections table of Realtime: one record for each WebSocket connection
 * and one for each channel subscription. The record type, the schema and the
 * KVStore options live here, so the CDK entry provisions exactly the table
 * that the runtime entry reads and writes.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';

/** One row of the connections table. */
export interface ConnectionRecord {
	connectionId: string;
	channel: string;
	expiresAt: number;
	connectedAt?: number;
	lastTtlSweep?: number;
}

const STRING_FIELDS = ['connectionId', 'channel'] as const;
const NUMBER_FIELDS = ['expiresAt', 'connectedAt', 'lastTtlSweep'] as const;

/**
 * Validation for connection records.
 *
 * The schema states the type of each field instead of passing values through.
 * KVStore probes it to learn the DynamoDB type of each key field and each
 * index field: it puts number samples in the field and reads the issues, at
 * synth and at run time. A pass-through schema would make `connectionId` and
 * `channel` number keys.
 */
export const connectionsSchema: StandardSchemaV1<ConnectionRecord> = {
	'~standard': {
		version: 1,
		vendor: 'blocks',
		validate: (value: unknown) => {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				return { issues: [{ message: 'connection record must be an object' }] };
			}
			const record = value as Record<string, unknown>;
			const issues: Array<{ message: string; path: [string] }> = [];
			for (const field of STRING_FIELDS) {
				if (field in record && typeof record[field] !== 'string') {
					issues.push({ message: `${field} must be a string`, path: [field] });
				}
			}
			for (const field of NUMBER_FIELDS) {
				if (field in record && typeof record[field] !== 'number') {
					issues.push({ message: `${field} must be a number`, path: [field] });
				}
			}
			return issues.length > 0 ? { issues } : { value: record as unknown as ConnectionRecord };
		},
	},
};

/** Options of the connections store, shared by the CDK entry, the runtime entry, and the tests. */
export const connectionsTableOptions = {
	schema: connectionsSchema,
	key: { partitionKey: 'connectionId', sortKey: 'channel' },
	indexes: { 'channel-index': { partitionKey: 'channel', sortKey: 'connectionId' } },
	ttl: 'expiresAt',
} as const;
