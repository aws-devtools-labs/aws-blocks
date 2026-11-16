// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The only module of the block that imports Kysely. No entry point of the block imports this module
// (kysely-free.test.ts), so an application that does not use Kysely does not load it.
import {
	type CompiledQuery,
	type DatabaseConnection,
	type DatabaseIntrospector,
	type Dialect,
	type DialectAdapter,
	type Driver,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
	type QueryCompiler,
	type QueryResult,
} from 'kysely';
import { quoteIdent } from './constants.js';
import { brandedError, configError, DatabaseErrors } from './errors.js';
import { internalAccess } from './runtime/internal.js';
import type { Session } from './runtime/session.js';
import type { ClusterRef } from './types.js';

interface DatabaseLike {
	readonly cluster: ClusterRef;
	readonly schemaName: string;
}

class Connection implements DatabaseConnection {
	constructor(readonly session: Session) {}

	async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
		const { rows, rowCount } = await this.session.run<R>(query.sql, [...query.parameters]);
		return { rows, numAffectedRows: BigInt(rowCount) };
	}

	streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
		throw brandedError(DatabaseErrors.QueryFailed, 'DatabaseDialect does not support streaming.');
	}
}

function sessionOf(connection: DatabaseConnection): Session {
	if (!(connection instanceof Connection)) throw configError('DatabaseDialect: not a connection of this dialect.');
	return connection.session;
}

class DatabaseDriver implements Driver {
	constructor(private readonly db: DatabaseLike) {}

	async init(): Promise<void> {}

	// The Database is resolved here, not in the constructor: a Kysely instance at module scope is also created
	// during CDK synth, where the block has no engine.
	async acquireConnection(): Promise<DatabaseConnection> {
		return new Connection(internalAccess(this.db, 'DatabaseDialect').session());
	}

	beginTransaction(
		connection: DatabaseConnection,
		settings: Parameters<Driver['beginTransaction']>[1],
	): Promise<void> {
		return sessionOf(connection).begin(settings);
	}

	commitTransaction(connection: DatabaseConnection): Promise<void> {
		return sessionOf(connection).commit();
	}

	rollbackTransaction(connection: DatabaseConnection): Promise<void> {
		return sessionOf(connection).rollback();
	}

	// Kysely skips a savepoint without a word when the driver has no method for it.
	async savepoint(connection: DatabaseConnection, name: string): Promise<void> {
		await sessionOf(connection).run(`savepoint ${quoteIdent(name)}`, []);
	}

	async rollbackToSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
		await sessionOf(connection).run(`rollback to savepoint ${quoteIdent(name)}`, []);
	}

	async releaseSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
		await sessionOf(connection).run(`release savepoint ${quoteIdent(name)}`, []);
	}

	async releaseConnection(connection: DatabaseConnection): Promise<void> {
		sessionOf(connection).release();
	}

	// The block owns the engine; Kysely's destroy() does not close it.
	async destroy(): Promise<void> {}
}

/**
 * A Kysely dialect for a `Database`: Kysely's PostgreSQL query compiler with the block's engine as the
 * driver. Kysely is an optional peer dependency of the block; install it in the application.
 *
 * Statements run through the same engine as `query()` and `transaction()`, so they use the block's schema
 * and fail with the same `DatabaseErrors` names. A Kysely statement inside the block's `transaction()`
 * callback runs in that transaction.
 *
 * Inside a Kysely transaction, run every statement on `trx`. A statement on the block or on the root
 * Kysely instance is not part of that transaction: on AWS it runs on another connection, and in local
 * mode it fails after five seconds.
 *
 * Create the Kysely instance at module scope; the dialect does not use the `Database` until the first
 * statement, so it is safe during CDK synth. Streaming (`.stream()`) is not supported. `destroy()` on the
 * Kysely instance does not close the block's connections.
 *
 * @param db - The `Database` whose schema and cluster the statements use
 * @throws {DatabaseErrors.QueryFailed} From a statement, as `query()` on the block does
 *
 * @example
 * import { type Generated, Kysely } from 'kysely';
 * import { DatabaseDialect } from '@aws-blocks/bb-database/kysely';
 *
 * interface Tables {
 *   orders: { id: Generated<number>; customer_id: string; total: number };
 * }
 *
 * const kysely = new Kysely<Tables>({ dialect: new DatabaseDialect(shop) });
 * const orders = await kysely.selectFrom('orders').selectAll().execute();
 */
export class DatabaseDialect implements Dialect {
	constructor(private readonly db: DatabaseLike) {}

	createDriver(): Driver {
		return new DatabaseDriver(this.db);
	}

	createQueryCompiler(): QueryCompiler {
		return new PostgresQueryCompiler();
	}

	createAdapter(): DialectAdapter {
		return new PostgresAdapter();
	}

	createIntrospector(db: Parameters<Dialect['createIntrospector']>[0]): DatabaseIntrospector {
		return new PostgresIntrospector(db);
	}
}
