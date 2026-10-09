// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { installClientUserAgent } from '@aws-blocks/core';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import {
	BeginTransactionCommand,
	CommitTransactionCommand,
	ExecuteStatementCommand,
	type Field,
	RDSDataClient,
	RollbackTransactionCommand,
} from '@aws-sdk/client-rds-data';
import { quoteIdent } from '../constants.js';
import {
	DatabaseErrors,
	isKnownDatabaseErrorName,
	reTagged,
	serializationConflict,
	TRANSIENT_DATA_API_ERROR_NAMES,
	uniqueConstraintConflict,
	wrapError,
} from '../errors.js';

/** Translate `$1`, `$2`, ... placeholders to `:p1`, `:p2`, ... for the Data API. */
function translateParams(
	sql: string,
	params?: unknown[],
): { sql: string; parameters: { name: string; value: Field }[] } {
	if (!params || params.length === 0) return { sql, parameters: [] };
	let translated = sql;
	const parameters: { name: string; value: Field }[] = [];
	for (let i = params.length - 1; i >= 0; i--) {
		translated = translated.replaceAll(`$${i + 1}`, `:p${i + 1}`);
		parameters.unshift({ name: `p${i + 1}`, value: toField(params[i]) });
	}
	return { sql: translated, parameters };
}

/** Marshal a JS value to a Data API Field. */
export function toField(value: unknown): Field {
	if (value === null || value === undefined) return { isNull: true };
	if (typeof value === 'string') return { stringValue: value };
	if (typeof value === 'number') return Number.isInteger(value) ? { longValue: value } : { doubleValue: value };
	if (typeof value === 'boolean') return { booleanValue: value };
	if (value instanceof Date) return { stringValue: value.toISOString() };
	if (Buffer.isBuffer(value)) return { blobValue: value };
	return { stringValue: JSON.stringify(value) };
}

/** Unmarshal a Data API Field to a JS value. */
export function fromField(field: Field): unknown {
	if (field.isNull) return null;
	if (field.stringValue !== undefined) return field.stringValue;
	if (field.longValue !== undefined) return Number(field.longValue);
	if (field.doubleValue !== undefined) return field.doubleValue;
	if (field.booleanValue !== undefined) return field.booleanValue;
	if (field.blobValue !== undefined) return Buffer.from(field.blobValue);
	return null;
}

const SQLSTATE_PATTERN = /SQLState:\s*([A-Z0-9]{5})/i;

/** Translate a Data API error to a DatabaseErrors name (SQLState first, then message text, then SDK exception name). */
function translateError(e: unknown): never {
	if (e instanceof Error) {
		if (isKnownDatabaseErrorName(e.name)) throw e;
		const msg = e.message || '';
		const stateMatch = msg.match(SQLSTATE_PATTERN);
		let name: string;
		if (stateMatch) {
			const code = stateMatch[1];
			if (code === '40001') throw serializationConflict(e);
			if (code === '23505') throw uniqueConstraintConflict(e);
			name = code.startsWith('08') ? DatabaseErrors.ConnectionFailed : DatabaseErrors.QueryFailed;
		} else if (/unique constraint|duplicate key/i.test(msg)) {
			throw uniqueConstraintConflict(e);
		} else if (TRANSIENT_DATA_API_ERROR_NAMES.has(e.name)) {
			name = DatabaseErrors.ConnectionFailed;
		} else {
			name = DatabaseErrors.QueryFailed;
		}
		console.debug(`[DataApiEngine] ${name}`);
		throw reTagged(name, e);
	}
	wrapError(e);
}

export interface DataApiEngineConfig {
	/** Aurora cluster ARN. */
	resourceArn: string;
	/** Secrets Manager ARN for credentials. */
	secretArn: string;
	/** Database name. */
	database: string;
	/**
	 * The schema unqualified names resolve in. The Data API has no session, so a
	 * non-`public` schema makes every auto-commit statement run inside a short
	 * transaction that first sets `search_path`. Omit for `public`.
	 */
	schema?: string;
	/** Optional pre-configured client (for testing). */
	client?: RDSDataClient;
	customUserAgent?: [string, string][];
}

/**
 * DatabaseEngine over the RDS Data API. Stateless: each call is an independent
 * HTTP request, so schema scoping rides on the transaction id.
 */
export class DataApiEngine implements DatabaseEngine {
	private readonly client: RDSDataClient;
	private readonly resourceArn: string;
	private readonly secretArn: string;
	private readonly database: string;
	private readonly schema?: string;

	constructor(config: DataApiEngineConfig) {
		this.resourceArn = config.resourceArn;
		this.secretArn = config.secretArn;
		this.database = config.database;
		this.schema = config.schema && config.schema !== 'public' ? config.schema : undefined;
		this.client =
			config.client ??
			new RDSDataClient(config.customUserAgent ? { customUserAgent: config.customUserAgent } : {});
		if (!config.client) installClientUserAgent(this.client);
	}

	private async send(
		sql: string,
		params: unknown[] | undefined,
		transactionId: string | undefined,
		withMetadata: boolean,
	) {
		const { sql: translated, parameters } = translateParams(sql, params);
		return this.client.send(
			new ExecuteStatementCommand({
				resourceArn: this.resourceArn,
				secretArn: this.secretArn,
				database: this.database,
				sql: translated,
				parameters,
				...(transactionId ? { transactionId } : {}),
				...(withMetadata ? { includeResultMetadata: true } : {}),
			}),
		);
	}

	private rows<T>(result: Awaited<ReturnType<DataApiEngine['send']>>): T[] {
		return (result.records || []).map((record) => {
			const row: Record<string, unknown> = {};
			record.forEach((field, i) => {
				row[result.columnMetadata?.[i]?.name || `col${i}`] = fromField(field);
			});
			return row as T;
		});
	}

	/** Run an auto-commit statement, inside a schema-setting transaction when the block has its own schema. */
	private async autocommit<R>(fn: (transactionId: string | undefined) => Promise<R>): Promise<R> {
		if (!this.schema) return fn(undefined);
		const handle = (await this.beginTransaction()) as string;
		try {
			const result = await fn(handle);
			await this.commitTransaction(handle);
			return result;
		} catch (e) {
			await this.rollbackTransaction(handle).catch(() => {});
			throw e;
		}
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		try {
			return await this.autocommit(async (tx) => this.rows<T>(await this.send(sql, params, tx, true)));
		} catch (e) {
			translateError(e);
		}
	}

	async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		try {
			return await this.autocommit(async (tx) => ({
				rowCount: (await this.send(sql, params, tx, false)).numberOfRecordsUpdated ?? 0,
			}));
		} catch (e) {
			translateError(e);
		}
	}

	async beginTransaction(): Promise<TransactionHandle> {
		try {
			const result = await this.client.send(
				new BeginTransactionCommand({
					resourceArn: this.resourceArn,
					secretArn: this.secretArn,
					database: this.database,
				}),
			);
			const transactionId = result.transactionId as string;
			if (this.schema)
				await this.send(`SET LOCAL search_path TO ${quoteIdent(this.schema)}`, undefined, transactionId, false);
			return transactionId;
		} catch (e) {
			translateError(e);
		}
	}

	async commitTransaction(handle: TransactionHandle): Promise<void> {
		try {
			await this.client.send(
				new CommitTransactionCommand({
					resourceArn: this.resourceArn,
					secretArn: this.secretArn,
					transactionId: handle as string,
				}),
			);
		} catch (e) {
			translateError(e);
		}
	}

	async rollbackTransaction(handle: TransactionHandle): Promise<void> {
		try {
			await this.client.send(
				new RollbackTransactionCommand({
					resourceArn: this.resourceArn,
					secretArn: this.secretArn,
					transactionId: handle as string,
				}),
			);
		} catch (e) {
			translateError(e);
		}
	}

	async queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
		try {
			return this.rows<T>(await this.send(sql, params, handle as string, true));
		} catch (e) {
			translateError(e);
		}
	}

	async executeInTransaction(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<{ rowCount: number }> {
		try {
			return { rowCount: (await this.send(sql, params, handle as string, false)).numberOfRecordsUpdated ?? 0 };
		} catch (e) {
			translateError(e);
		}
	}

	/** No-op: the Data API holds no connections. */
	async destroy(): Promise<void> {}
}
