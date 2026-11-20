// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// A Database whose every statement carries one user's identity, for Row Level Security policies (DESIGN §4.5).
import type { TransactionHandle } from '../common/engine.js';
import type { SqlQuery } from '../common/sql.js';
import { APP_ROLE_PLACEHOLDER, CLAIMS_SETTING, quoteIdent } from '../constants.js';
import {
	CountedEngine,
	type CountedRows,
	firstStatement,
	type RowCountingEngine,
	type TransactionModes,
	withTransaction,
} from '../engines/handle.js';
import {
	asError,
	configError,
	DatabaseErrors,
	PG_INSUFFICIENT_PRIVILEGE,
	permissionDenied,
	sqlStateOf,
} from '../errors.js';
import type { ClusterRef, QueryOptions, ScopedDatabase, Transaction, TransactionOptions } from '../types.js';
import { DatabaseCore } from './index.js';
import { internalAccess, registerInternalAccess } from './internal.js';

const SET_CLAIMS = `SELECT set_config('${CLAIMS_SETTING}', $1, true)`;
// One statement and two bound parameters: `set_config('role', …, true)` is `SET LOCAL ROLE` with a value that
// can be a parameter, so the role name is never part of the SQL text.
const SET_ROLE_AND_CLAIMS = `SELECT set_config('role', $1, true), set_config('${CLAIMS_SETTING}', $2, true)`;

/** The statement that opens every transaction of a scoped database. */
interface Identity {
	sql: string;
	params: unknown[];
	/** Turns a failure of that statement into the error the caller sees. */
	refused?: (e: unknown) => unknown;
}

// PostgreSQL refuses the switch when the connection role is not a member of the role (42501) or the role
// does not exist (22023). Both are setup mistakes, the same on every call, so they are not the caller's 403.
const PG_INVALID_PARAMETER_VALUE = '22023';

// The fix is a migration, not a statement the app can run: the app role cannot grant itself a role, and in a
// migration CURRENT_USER is the cluster admin. `${app_role}` names the app role in every place a file runs.
// The grant gives the right to switch only (INHERIT FALSE): with a plain grant the app role would inherit the
// role, and the role's policies would apply to statements outside asRole() as well.
function roleRefused(fullId: string, role: string): (e: unknown) => unknown {
	return (e) => {
		const code = sqlStateOf(e);
		if (code !== PG_INSUFFICIENT_PRIVILEGE && code !== PG_INVALID_PARAMETER_VALUE) return e;
		console.error(
			`[Database] ${fullId}: asRole('${role}') was refused by PostgreSQL (SQLSTATE ${code}). The role must ` +
				`exist and the role the app connects as must be a member of it. Add a migration file with ` +
				`GRANT ${quoteIdent(role)} TO ${APP_ROLE_PLACEHOLDER} WITH INHERIT FALSE, SET TRUE; (the migration runner ` +
				`replaces ${APP_ROLE_PLACEHOLDER} with that role; before PostgreSQL 16, leave out the WITH clause).`,
		);
		return configError(
			`Database '${fullId}': the connection role cannot switch to the role given to asRole(). ` +
				'The server log names the role and the GRANT to run.',
		);
	};
}

// SQLSTATE 42501 from the user's statement: a policy's WITH CHECK refused the row, or the role has no grant.
function refused(e: unknown): never {
	if (e instanceof Error && e.name === DatabaseErrors.QueryFailed && sqlStateOf(e) === PG_INSUFFICIENT_PRIVILEGE) {
		throw permissionDenied(asError(e.cause));
	}
	throw e;
}

/**
 * The block's engine with the user's claims set at the start of every transaction. It is the scoped
 * DatabaseCore's only engine, so every exit (a statement, `transaction()`, a Kysely connection) begins here.
 * The setting is transaction-local, so a single statement gets a transaction of its own.
 */
class ScopedEngine extends CountedEngine implements RowCountingEngine {
	constructor(
		private readonly inner: () => Promise<RowCountingEngine>,
		private readonly identity: Identity,
	) {
		super();
	}

	async beginTransaction(modes?: TransactionModes): Promise<TransactionHandle> {
		const engine = await this.inner();
		const handle = await engine.beginTransaction(modes);
		try {
			await firstStatement(engine, handle, this.identity.sql, this.identity.params);
		} catch (e) {
			throw this.identity.refused ? this.identity.refused(e) : e;
		}
		return handle;
	}

	async commitTransaction(handle: TransactionHandle): Promise<void> {
		await (await this.inner()).commitTransaction(handle);
	}

	async rollbackTransaction(handle: TransactionHandle): Promise<void> {
		await (await this.inner()).rollbackTransaction(handle);
	}

	async queryCountedInTransaction<T>(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<CountedRows<T>> {
		const engine = await this.inner();
		return engine.queryCountedInTransaction<T>(handle, sql, params).catch(refused);
	}

	queryCounted<T>(sql: string, params?: unknown[]): Promise<CountedRows<T>> {
		return withTransaction(this, (handle) => this.queryCountedInTransaction<T>(handle, sql, params));
	}

	// The block owns the engine.
	async destroy(): Promise<void> {}
}

interface ScopedParent {
	readonly cluster: ClusterRef;
	readonly schemaName: string;
	readonly fullId: string;
}

class UserDatabase implements ScopedDatabase {
	readonly cluster: ClusterRef;
	readonly schemaName: string;
	private readonly core: DatabaseCore;

	constructor(parent: ScopedParent, identity: Identity, caller: string) {
		this.cluster = parent.cluster;
		this.schemaName = parent.schemaName;
		const access = internalAccess(parent, caller);
		const engine = new ScopedEngine(() => access.engine(), identity);
		this.core = new DatabaseCore({ engine: async () => engine });
		// What the Kysely dialect and the test helpers reach is the scoped engine; this object has no other.
		registerInternalAccess(this, {
			...access,
			engine: () => this.core.getEngine(),
			session: () => this.core.session(),
		});
	}

	query<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T[]> {
		return this.core.query<T>(query, options);
	}

	queryOne<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T | null> {
		return this.core.queryOne<T>(query, options);
	}

	execute(query: SqlQuery): Promise<{ rowCount: number }> {
		return this.core.execute(query);
	}

	transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
		return this.core.transaction(fn, options);
	}
}

/**
 * Why `asUser()` is refused on a `LegacyDatabaseCluster`. On AWS the statements run as the user of the cluster's
 * secret, which owns the tables, and PostgreSQL applies no policy to an owner: the claims would filter nothing.
 * Local mode refuses it too, so that code which would read every row after a deploy does not pass locally.
 */
export function ownerBypassesPolicies(fullId: string): Error {
	return configError(
		`Database '${fullId}': asUser() does not filter rows on a LegacyDatabaseCluster, because the statements run ` +
			'as the user that owns the tables. Use asRole(role, claims) with a role that your policies apply to.',
	);
}

/** `Database.asUser()` for the local and the Lambda entry. */
export function scopedDatabase(
	parent: ScopedParent,
	user: { userId: string },
	claims?: Record<string, unknown>,
): ScopedDatabase {
	if (parent.cluster.kind === 'dsql') {
		throw configError(
			`Database '${parent.fullId}': asUser() needs Row Level Security, which Aurora DSQL does not have. ` +
				"Put the block on an aurora cluster: new DatabaseCluster(scope, 'main', { type: 'aurora' }).",
		);
	}
	if (typeof user?.userId !== 'string' || user.userId === '') {
		throw configError(`Database '${parent.fullId}': asUser() needs a user with a userId.`);
	}
	// `sub` last: a claim cannot replace the user id.
	return new UserDatabase(
		parent,
		{ sql: SET_CLAIMS, params: [JSON.stringify({ ...claims, sub: user.userId })] },
		'asUser()',
	);
}

/**
 * `Database.asRole()` for the local and the Lambda entry: every transaction starts by switching to `role` and
 * setting the claims, both for that transaction only. The claims are the caller's, unchanged.
 */
export function roleDatabase(parent: ScopedParent, role: string, claims?: Record<string, unknown>): ScopedDatabase {
	if (parent.cluster.kind === 'dsql') {
		throw configError(
			`Database '${parent.fullId}': asRole() needs Row Level Security, which Aurora DSQL does not have.`,
		);
	}
	if (typeof role !== 'string' || role === '') {
		throw configError(`Database '${parent.fullId}': asRole() needs the name of a database role.`);
	}
	return new UserDatabase(
		parent,
		{
			sql: SET_ROLE_AND_CLAIMS,
			params: [role, JSON.stringify(claims ?? {})],
			refused: roleRefused(parent.fullId, role),
		},
		'asRole()',
	);
}
