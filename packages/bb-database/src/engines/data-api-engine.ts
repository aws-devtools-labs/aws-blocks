// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The engine of an Aurora PostgreSQL cluster that is reached through the RDS Data API: no socket and no VPC,
// one HTTPS call for each statement, and a Secrets Manager secret as the credential. It gives parameters and
// results the forms that `Database` of `@aws-blocks/bb-data` gave them, so an app that moves from that block
// reads the same values.

import { setTimeout as sleep } from 'node:timers/promises';
import {
	type ArrayValue,
	BeginTransactionCommand,
	type ColumnMetadata,
	CommitTransactionCommand,
	ExecuteStatementCommand,
	type ExecuteStatementCommandOutput,
	type Field,
	RDSDataClient,
	RollbackTransactionCommand,
	type SqlParameter,
} from '@aws-sdk/client-rds-data';
import type { TransactionHandle } from '../common/engine.js';
import { DOLLAR_QUOTE_TAG_RE } from '../common/split-statements.js';
import {
	asError,
	PG_CANNOT_CONNECT_NOW,
	PG_INVALID_AUTHORIZATION_CLASS,
	pgErrorCode,
	translatePgError,
} from '../errors.js';
import type { DataApiOptions } from '../types.js';
import {
	CountedEngine,
	type CountedRows,
	EngineTransaction,
	firstStatement,
	isSettled,
	openTransaction,
	type RowCountingEngine,
	setTransactionStatement,
	type TransactionModes,
} from './handle.js';

/** @internal The part of `RDSDataClient` the engine uses; tests give a stand-in. */
export type DataApiClient = Pick<RDSDataClient, 'send' | 'destroy'>;

const ENGINE = 'DataApiEngine';

// Where the quoted text that starts at `start` ends: after the closing quote, with a doubled quote as an escape.
function endOfQuoted(sql: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < sql.length) {
		if (sql[i] === quote && sql[i + 1] === quote) i += 2;
		else if (sql[i] === quote) return i + 1;
		else i++;
	}
	return sql.length;
}

// Where the text that is not code and starts at `i` ends: a string, a quoted identifier, a comment or a
// dollar-quoted body. Undefined when code starts at `i`.
function endOfNonCode(sql: string, i: number): number | undefined {
	const c = sql[i];
	if (c === "'" || c === '"') return endOfQuoted(sql, i, c);
	if (c === '-' && sql[i + 1] === '-') {
		const newline = sql.indexOf('\n', i);
		return newline === -1 ? sql.length : newline + 1;
	}
	if (c === '/' && sql[i + 1] === '*') {
		const end = sql.indexOf('*/', i + 2);
		return end === -1 ? sql.length : end + 2;
	}
	if (c === '$') {
		const tag = DOLLAR_QUOTE_TAG_RE.exec(sql.slice(i, i + 64))?.[0];
		if (tag) {
			const close = sql.indexOf(tag, i + tag.length);
			return close === -1 ? sql.length : close + tag.length;
		}
	}
	return undefined;
}

// PostgreSQL accepts non-ASCII bytes in identifiers and `$` after the first character.
const UNQUOTED_IDENTIFIER = /[A-Za-z_\u0080-\uffff][A-Za-z_0-9$\u0080-\uffff]*/y;
const PLACEHOLDER = /\$([1-9]\d*)/y;

/**
 * `$1`, `$2`, … become the named parameters `:p1`, `:p2`, … of the Data API. A placeholder is the longest run of
 * digits after `$` that is the number of a parameter: `$10` is `:p10` with ten parameters, and `:p1` followed by
 * `0` with three. Text in a string, an identifier, a comment or a dollar-quoted body stays as it is, as it
 * does on a PostgreSQL connection.
 */
export function namedParameters(sql: string, params?: unknown[]): { sql: string; parameters: SqlParameter[] } {
	if (!params || params.length === 0) return { sql, parameters: [] };
	let text = '';
	let copied = 0;
	let i = 0;
	while (i < sql.length) {
		const end = endOfNonCode(sql, i);
		if (end !== undefined) {
			i = end;
			continue;
		}
		UNQUOTED_IDENTIFIER.lastIndex = i;
		if (UNQUOTED_IDENTIFIER.test(sql)) {
			i = UNQUOTED_IDENTIFIER.lastIndex;
			continue;
		}
		PLACEHOLDER.lastIndex = i;
		const digits = sql[i] === '$' ? PLACEHOLDER.exec(sql)?.[1] : undefined;
		if (digits === undefined) {
			i++;
			continue;
		}
		let length = digits.length;
		while (length > 0 && Number(digits.slice(0, length)) > params.length) length--;
		if (length > 0) {
			text += `${sql.slice(copied, i)}:p${digits.slice(0, length)}`;
			copied = i + 1 + length;
		}
		i += 1 + digits.length;
	}
	return {
		sql: text + sql.slice(copied),
		parameters: params.map((value, n) => ({ name: `p${n + 1}`, value: toField(value) })),
	};
}

/**
 * A JavaScript value as a Data API field. A `Date` goes as its ISO text and an object or an array as its JSON
 * text, both as strings: a statement that writes one to a `timestamptz` or `jsonb` column casts the parameter.
 * The Data API has no array parameters.
 */
export function toField(value: unknown): Field {
	if (value === null || value === undefined) return { isNull: true };
	if (typeof value === 'string') return { stringValue: value };
	if (typeof value === 'number') return Number.isInteger(value) ? { longValue: value } : { doubleValue: value };
	if (typeof value === 'bigint') {
		return Number.isSafeInteger(Number(value)) ? { longValue: Number(value) } : { stringValue: value.toString() };
	}
	if (typeof value === 'boolean') return { booleanValue: value };
	if (value instanceof Date) return { stringValue: value.toISOString() };
	if (value instanceof Uint8Array) return { blobValue: value };
	return { stringValue: JSON.stringify(value) };
}

const JSON_TYPE_NAMES = new Set(['json', 'jsonb']);
const JSON_ARRAY_TYPE_NAMES = new Set(['_json', '_jsonb']);

// A value the server returned as json is JSON; text that is not stays as it is, so one odd row does not fail a query.
function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

// A SQL array can hold NULL elements; each one stays `null`.
function fromArrayValue(array: ArrayValue, typeName?: string): unknown[] {
	if (array.stringValues !== undefined) {
		const json = typeName !== undefined && JSON_ARRAY_TYPE_NAMES.has(typeName);
		return array.stringValues.map((v) => (v === null ? null : json ? parseJson(v) : v));
	}
	if (array.longValues !== undefined) return array.longValues.map((v) => (v === null ? null : Number(v)));
	if (array.doubleValues !== undefined) return array.doubleValues.map((v) => v);
	if (array.booleanValues !== undefined) return array.booleanValues.map((v) => v);
	if (array.arrayValues !== undefined) {
		return array.arrayValues.map((v) => (v === null ? null : fromArrayValue(v, typeName)));
	}
	return [];
}

/**
 * A Data API field as a JavaScript value. `typeName` is the column's type from the result metadata: a `json` or
 * `jsonb` column arrives as text and is parsed, and an array column becomes an array.
 */
export function fromField(field: Field, typeName?: string): unknown {
	if (field.isNull) return null;
	if (field.arrayValue !== undefined) return fromArrayValue(field.arrayValue, typeName);
	if (field.stringValue !== undefined) {
		return typeName !== undefined && JSON_TYPE_NAMES.has(typeName)
			? parseJson(field.stringValue)
			: field.stringValue;
	}
	if (field.longValue !== undefined) return Number(field.longValue);
	if (field.doubleValue !== undefined) return field.doubleValue;
	if (field.booleanValue !== undefined) return field.booleanValue;
	if (field.blobValue !== undefined) return Buffer.from(field.blobValue);
	return null;
}

function toRow<T>(record: Field[], columns: ColumnMetadata[] | undefined): T {
	const row: Record<string, unknown> = {};
	record.forEach((field, i) => {
		const column = columns?.[i];
		row[column?.name || `col${i}`] = fromField(field, column?.typeName);
	});
	return row as T;
}

const CHANGES_ROWS = /^\s*(?:INSERT|UPDATE|DELETE|MERGE)\b/i;

// The rows a statement changed. The service reports the count for a statement that returns no rows; for a
// statement with RETURNING, the rows it returned are the rows it changed.
function counted<T>(result: ExecuteStatementCommandOutput, sql: string): CountedRows<T> {
	const rows = (result.records ?? []).map((record) => toRow<T>(record, result.columnMetadata));
	const updated = result.numberOfRecordsUpdated ?? 0;
	return { rows, rowCount: updated > 0 || !CHANGES_ROWS.test(sql) ? updated : rows.length };
}

// The Data API puts the SQLSTATE at the end of the message (`…; SQLState: 23505`). PostgreSQL can repeat caller
// text earlier in the message, so only the last match counts.
const SQLSTATE_PATTERN = /SQLState:\s*([A-Z0-9]{5})/gi;
const lastSqlState = (message: string): string | undefined => [...message.matchAll(SQLSTATE_PATTERN)].at(-1)?.[1];

// A cluster at minimum capacity 0 was paused; the call that found it paused has started its resume.
const RESUMING_ERROR_NAME = 'DatabaseResumingException';
// The service or the cluster cannot answer now.
const UNAVAILABLE_ERROR_NAMES = new Set([
	RESUMING_ERROR_NAME,
	'DatabaseUnavailableException',
	'ServiceUnavailableException',
	'ServiceUnavailableError',
	'InternalServerErrorException',
]);
// What the Data API answers while the writer instance of a new cluster is not ready.
const WRITER_NOT_READY_MESSAGE = /Communications link failure/;
const PG_INVALID_PASSWORD = '28P01';
const CREDENTIAL_REFUSED_ERROR_NAMES = new Set(['BadRequestException', 'DatabaseErrorException']);
const CREDENTIAL_REFUSED_MESSAGE = /password authentication failed|authentication failed for user/i;
// Quoted text in a server message can be caller input.
const outsideQuotes = (message: string): string => message.replace(/"[^"]*"|'[^']*'/g, '');

/**
 * The SQLSTATE a Data API error stands for. The server's own code when the message has one. Otherwise `57P03`
 * when the service or the cluster cannot answer now, and `28P01` when the server refused the credential of the
 * secret without a code.
 */
function sqlStateOfDataApiError(e: Error): string | undefined {
	const code = lastSqlState(e.message ?? '');
	if (code) return code;
	if (UNAVAILABLE_ERROR_NAMES.has(e.name) || WRITER_NOT_READY_MESSAGE.test(e.message ?? '')) {
		return PG_CANNOT_CONNECT_NOW;
	}
	if (CREDENTIAL_REFUSED_ERROR_NAMES.has(e.name) && CREDENTIAL_REFUSED_MESSAGE.test(outsideQuotes(e.message ?? ''))) {
		return PG_INVALID_PASSWORD;
	}
	return undefined;
}

/** Gives the error the `code` that the block's translation reads, then translates it. */
function translate(raw: unknown): never {
	const e = asError(raw);
	const code = pgErrorCode(e) ?? sqlStateOfDataApiError(e);
	if (code !== undefined && pgErrorCode(e) === undefined) {
		Object.defineProperty(e, 'code', { value: code, enumerable: false, configurable: true });
	}
	translatePgError(e, ENGINE);
}

// A paused cluster resumes in about 20 seconds; the waits end inside the deadline of a request.
const RESUME_RETRY_DELAY_MS = 3000;
const RESUME_RETRY_BUDGET_MS = 24_000;
const CREDENTIAL_RETRY_ATTEMPTS = 3;
const CREDENTIAL_RETRY_BASE_DELAY_MS = 3000;

class DataApiTransaction extends EngineTransaction {
	constructor(readonly id: string) {
		super();
	}
}

const open = (handle: TransactionHandle): DataApiTransaction => openTransaction(handle, DataApiTransaction, ENGINE);

export class DataApiEngine extends CountedEngine implements RowCountingEngine {
	/**
	 * The Data API takes one statement in a call. A caller that would send several in one text, as the migration
	 * runner does with its settings, reads this and sends them one by one.
	 */
	readonly oneStatementPerCall = true;

	private readonly target: { resourceArn: string; secretArn: string };
	private readonly database: string;

	/** `client` and `wait` are stand-ins for the SDK client and the timer in tests. */
	constructor(
		coordinates: DataApiOptions,
		private readonly client: DataApiClient = new RDSDataClient({}),
		private readonly wait: (ms: number) => Promise<unknown> = sleep,
	) {
		super();
		this.target = { resourceArn: coordinates.clusterArn, secretArn: coordinates.secretArn };
		this.database = coordinates.database;
	}

	/**
	 * Runs `send` again after an answer that says the statement did not run and that passes:
	 *
	 * - The cluster was paused. The call has started its resume, and the service says to try again.
	 * - The server refused the credential. A rotation of the secret sets the new password on the cluster and
	 *   then publishes it, and a call in between reads the old one.
	 *
	 * Only for a call that opens its own connection: a statement in a transaction keeps one transaction id,
	 * which a wait can outlive.
	 */
	private async whenReady<T>(send: () => Promise<T>): Promise<T> {
		let waited = 0;
		for (let attempt = 1; ; attempt++) {
			try {
				return await send();
			} catch (raw) {
				const e = asError(raw);
				let delayMs: number;
				if (e.name === RESUMING_ERROR_NAME && waited + RESUME_RETRY_DELAY_MS <= RESUME_RETRY_BUDGET_MS) {
					delayMs = RESUME_RETRY_DELAY_MS;
				} else if (
					sqlStateOfDataApiError(e)?.startsWith(PG_INVALID_AUTHORIZATION_CLASS) &&
					attempt < CREDENTIAL_RETRY_ATTEMPTS
				) {
					delayMs = CREDENTIAL_RETRY_BASE_DELAY_MS * attempt;
				} else {
					throw raw;
				}
				console.warn(`[${ENGINE}] ${e.name}: the statement did not run`, { attempt, retryInMs: delayMs });
				waited += delayMs;
				await this.wait(delayMs);
			}
		}
	}

	private statement(sql: string, params: unknown[] | undefined, transactionId?: string) {
		const { sql: text, parameters } = namedParameters(sql, params);
		return new ExecuteStatementCommand({
			...this.target,
			database: this.database,
			sql: text,
			parameters,
			includeResultMetadata: true,
			...(transactionId !== undefined ? { transactionId } : {}),
		});
	}

	async queryCounted<T>(sql: string, params?: unknown[]): Promise<CountedRows<T>> {
		try {
			return counted(await this.whenReady(() => this.client.send(this.statement(sql, params))), sql);
		} catch (e) {
			translate(e);
		}
	}

	// No retry: the server has aborted a transaction when it reports an error, and the caller retries the whole
	// transaction.
	async queryCountedInTransaction<T>(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<CountedRows<T>> {
		const tx = open(handle);
		try {
			return counted(await this.client.send(this.statement(sql, params, tx.id)), sql);
		} catch (e) {
			translate(e);
		}
	}

	async beginTransaction(modes?: TransactionModes): Promise<TransactionHandle> {
		const settings = setTransactionStatement(modes);
		let tx: DataApiTransaction;
		try {
			const began = await this.whenReady(() =>
				this.client.send(new BeginTransactionCommand({ ...this.target, database: this.database })),
			);
			if (!began.transactionId) throw new Error('The Data API returned no transaction id.');
			tx = new DataApiTransaction(began.transactionId);
		} catch (e) {
			translate(e);
		}
		if (settings) await firstStatement(this, tx, settings);
		return tx;
	}

	private async rollback(tx: DataApiTransaction): Promise<void> {
		try {
			await this.client.send(new RollbackTransactionCommand({ ...this.target, transactionId: tx.id }));
		} catch (e) {
			// The service ends a transaction that nothing commits; the caller already has its own error.
			console.error(`[${ENGINE}] rollback failed`, { name: asError(e).name });
		}
	}

	// The handle is settled either way. A commit that the server refused has ended the transaction there. A
	// commit that did not reach the server has not, so the transaction is rolled back here: it would otherwise
	// keep its locks until the service ends it.
	async commitTransaction(handle: TransactionHandle): Promise<void> {
		const tx = open(handle);
		tx.settled = true;
		try {
			await this.client.send(new CommitTransactionCommand({ ...this.target, transactionId: tx.id }));
		} catch (e) {
			await this.rollback(tx);
			translate(e);
		}
	}

	async rollbackTransaction(handle: TransactionHandle): Promise<void> {
		if (isSettled(handle)) return;
		const tx = open(handle);
		tx.settled = true;
		await this.rollback(tx);
	}

	async destroy(): Promise<void> {
		this.client.destroy();
	}
}
