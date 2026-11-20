// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Database.asUser() against the local engine of an aurora cluster: every exit of the scoped database carries
// the user, and nothing else does.
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { ApiError, isBlocksError } from '@aws-cdk-blocks/core';
import { type Generated, Kysely, sql as ksql } from 'kysely';
import { APP_ROLE_PLACEHOLDER, CLAIMS_SETTING } from './constants.js';
import { Database, DatabaseCluster, DatabaseErrors, sql } from './index.mock.js';
import { DatabaseDialect } from './kysely.js';
import { DatabaseCore } from './runtime/index.js';
import { internalAccess, registerInternalAccess } from './runtime/internal.js';
import { scopedDatabase } from './runtime/scoped.js';
import { migrations, ROLE_TODOS } from './test-support/fixtures.js';
import { freshScope, installLocalTestHooks } from './test-support/lifecycle.js';
import { RecordingEngine } from './test-support/recording-engine.js';
import { simulateConflict } from './testing.js';

installLocalTestHooks({ mockDataPrefix: 'bbuser' });

interface Tables {
	notes: { id: Generated<number>; owner_id: string; body: string };
}

const CLAIMS = `current_setting('${CLAIMS_SETTING}', true)::jsonb`;
const SCHEMA = [
	'CREATE TABLE notes (id SERIAL PRIMARY KEY, owner_id TEXT NOT NULL, body TEXT NOT NULL);',
	'ALTER TABLE notes ENABLE ROW LEVEL SECURITY;',
	`CREATE POLICY notes_owner ON notes USING (owner_id = ${CLAIMS} ->> 'sub');`,
	// Server code that must see every row passes a claim of its own, which this policy admits.
	`CREATE POLICY notes_service ON notes USING ((${CLAIMS} ->> 'service')::boolean);`,
	"INSERT INTO notes (owner_id, body) VALUES ('alice', 'a1'), ('alice', 'a2'), ('bob', 'b1');",
].join('\n');

function setup() {
	const scope = freshScope('bbuser');
	const cluster = new DatabaseCluster(scope, 'main', { type: 'aurora' });
	const db = new Database(scope, 'app', { cluster, migrationsPath: migrations({ '001.sql': SCHEMA }) });
	return { db, alice: db.asUser({ userId: 'alice' }), bob: db.asUser({ userId: 'bob' }) };
}

interface Note {
	body: string;
}
const notes = sql`SELECT body FROM notes ORDER BY id`;
const bodies = (rows: Note[]) => rows.map((r) => r.body);
const insertFor = (owner: string) => sql`INSERT INTO notes (owner_id, body) VALUES (${owner}, 'new')`;
const denied = (e: unknown) =>
	isBlocksError(e, DatabaseErrors.PermissionDenied) && e instanceof ApiError && e.status === 403;

describe('Database.asUser()', () => {
	test('every exit of a scoped database returns the user’s rows only; the block itself has no user', async () => {
		const { db, alice, bob } = setup();
		assert.deepStrictEqual(await db.query<Note>(notes), [], 'a statement with no user, on a fresh session');

		assert.deepStrictEqual(bodies(await alice.query<Note>(notes)), ['a1', 'a2']);
		assert.deepStrictEqual(await bob.queryOne<Note>(notes), { body: 'b1' });
		assert.strictEqual((await alice.execute(sql`UPDATE notes SET body = body`)).rowCount, 2);
		await alice.transaction(async (tx) => {
			assert.deepStrictEqual(bodies(await tx.query<Note>(notes)), ['a1', 'a2']);
			assert.deepStrictEqual(bodies(await alice.query<Note>(notes)), ['a1', 'a2'], 'joins the transaction');
		});

		const kysely = new Kysely<Tables>({ dialect: new DatabaseDialect(bob) });
		assert.deepStrictEqual(await kysely.selectFrom('notes').select('body').execute(), [{ body: 'b1' }]);
		const inTransaction = await kysely
			.transaction()
			.setIsolationLevel('serializable')
			.execute(async (trx) => ({
				rows: await trx.selectFrom('notes').select('body').execute(),
				iso: (await ksql<{ iso: string }>`select current_setting('transaction_isolation') as iso`.execute(trx))
					.rows[0]?.iso,
			}));
		assert.deepStrictEqual(inTransaction, { rows: [{ body: 'b1' }], iso: 'serializable' });

		assert.deepStrictEqual(await db.query<Note>(notes), [], 'no user is left on the session');
	});

	test('a write that a policy refuses is PermissionDenied (403); a hidden row is no error', async () => {
		const { db, alice } = setup();
		await assert.rejects(alice.execute(insertFor('bob')), denied);
		await assert.rejects(
			alice.transaction((tx) => tx.execute(insertFor('bob'))),
			denied,
		);
		const kysely = new Kysely<Tables>({ dialect: new DatabaseDialect(alice) });
		await assert.rejects(kysely.insertInto('notes').values({ owner_id: 'bob', body: 'new' }).execute(), denied);

		assert.strictEqual((await alice.execute(insertFor('alice'))).rowCount, 1);
		assert.strictEqual((await alice.execute(sql`DELETE FROM notes WHERE owner_id = 'bob'`)).rowCount, 0);
		// Without a user the same refusal is the application's own mistake, not the caller's.
		await assert.rejects(db.execute(insertFor('bob')), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.QueryFailed),
		);
	});

	test('claims reach the policy, `sub` is always the user id, and only `userId` is read from the user', async () => {
		const { db } = setup();
		const row = await db
			.asUser({ userId: 'alice' }, { sub: 'bob', org_id: 'o1' })
			.queryOne<{ claims: Record<string, unknown> }>(
				sql`SELECT current_setting('request.jwt.claims', true)::jsonb AS claims`,
			);
		assert.deepStrictEqual(row?.claims, { org_id: 'o1', sub: 'alice' });

		const service = db.asUser({ userId: 'system' }, { service: true });
		assert.deepStrictEqual(bodies(await service.query<Note>(notes)), ['a1', 'a2', 'b1']);
		// An auth user that carries a `claims` field of its own (an OIDC user's token claims) passes none of them.
		const oidcUser = { userId: 'alice', claims: { service: true } };
		assert.deepStrictEqual(bodies(await db.asUser(oidcUser).query<Note>(notes)), ['a1', 'a2']);
	});

	test('nested in another transaction, a statement runs as its own database’s user and leaves the outer one as it was', async () => {
		const { db, alice, bob } = setup();
		await db.transaction(async (tx) => {
			assert.deepStrictEqual(bodies(await alice.query<Note>(notes)), ['a1', 'a2']);
			assert.deepStrictEqual(await tx.query<Note>(notes), [], 'the enclosing transaction still has no user');
		});
		await alice.transaction(async (tx) => {
			assert.deepStrictEqual(await db.query<Note>(notes), [], 'a statement on the block carries no user');
			assert.deepStrictEqual(bodies(await bob.query<Note>(notes)), ['b1']);
			assert.deepStrictEqual(
				bodies(await tx.query<Note>(notes)),
				['a1', 'a2'],
				'the transaction is still alice’s',
			);
		});
	});

	test('a single statement is retried on a conflict, as on the block', async () => {
		const { alice } = setup();
		simulateConflict(alice);
		assert.strictEqual((await alice.execute(sql`UPDATE notes SET body = 'z'`)).rowCount, 2);
	});

	test('asUser() is refused on a dsql cluster and without a user id', () => {
		const { db } = setup();
		const dsql = new Database(freshScope('bbuser'), 'd');
		assert.throws(() => dsql.asUser({ userId: 'alice' }), {
			name: 'DatabaseConfigurationError',
			message: /Aurora DSQL does not have/,
		});
		assert.throws(() => db.asUser({ userId: '' }), /needs a user with a userId/);
	});

	test('on any engine, every statement runs in a transaction whose first statement sets the claims', async () => {
		const engine = new RecordingEngine();
		const core = new DatabaseCore({ engine: async () => engine });
		const parent = { cluster: { kind: 'aurora' as const, id: 'c' }, schemaName: 's', fullId: 'p' };
		registerInternalAccess(parent, {
			engine: () => core.getEngine(),
			session: () => core.session(),
			simulateConflict: () => {},
			migrationsPath: undefined,
		});
		const scoped = scopedDatabase(parent, { userId: 'u1' }, { org: 'o' });

		await scoped.query(sql`SELECT 1`);
		await scoped.execute(sql`UPDATE t SET x = 1`);
		await scoped.transaction(async (tx) => {
			await tx.query(sql`SELECT 2`);
			await scoped.queryOne(sql`SELECT 3`);
		});
		// What the Kysely dialect uses.
		const session = internalAccess(scoped, 'test').session();
		await session.run('select 4', []);
		await session.begin({ isolationLevel: 'serializable' });
		await session.run('select 5', []);
		await session.commit();

		const setClaims = `SELECT set_config('${CLAIMS_SETTING}', $1, true)`;
		const byTransaction = new Map<unknown, string[]>();
		for (const call of engine.calls) {
			assert.ok(call.handle, `'${call.sql}' ran outside a transaction`);
			byTransaction.set(call.handle, [...(byTransaction.get(call.handle) ?? []), call.sql]);
		}
		assert.deepStrictEqual(
			[...byTransaction.values()],
			[
				['BEGIN', setClaims, 'SELECT 1', 'COMMIT'],
				['BEGIN', setClaims, 'UPDATE t SET x = 1', 'COMMIT'],
				['BEGIN', setClaims, 'SELECT 2', 'SELECT 3', 'COMMIT'],
				['BEGIN', setClaims, 'select 4', 'COMMIT'],
				// PostgreSQL takes an isolation level only before the first query.
				['BEGIN', 'set transaction isolation level serializable', setClaims, 'select 5', 'COMMIT'],
			],
		);
		const claims = engine.calls.filter((c) => c.sql === setClaims).map((c) => c.params[0]);
		assert.deepStrictEqual(new Set(claims), new Set([JSON.stringify({ org: 'o', sub: 'u1' })]));
	});
});

// Local mode runs a block's statements as `blocks_app_local`, where AWS runs them as `blocks_app_{cluster}`: the
// one file that grants to the app role is the same in both places.
describe('Database.asRole() on a cluster the block provisions', () => {
	// The block's schema on a shared cluster is its id.
	const ROLE_SCHEMA = `${ROLE_TODOS}\nGRANT USAGE ON SCHEMA app TO authenticated;`;
	const titles = sql`SELECT title FROM todos ORDER BY id`;

	function block(files: Record<string, string>) {
		const scope = freshScope('bbuser');
		const cluster = new DatabaseCluster(scope, 'main', { type: 'aurora' });
		return new Database(scope, 'app', { cluster, migrationsPath: migrations(files) });
	}

	// A policy of the role that passes without claims. With a plain `GRANT authenticated TO ${app_role}` the app
	// role inherits the role, and a statement that does not go through asRole() then reads these rows too.
	const OPEN_POSTS = [
		'CREATE TABLE posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL);',
		'ALTER TABLE posts ENABLE ROW LEVEL SECURITY;',
		'GRANT SELECT ON posts TO authenticated;',
		'CREATE POLICY posts_read ON posts FOR SELECT TO authenticated USING (true);',
		"INSERT INTO posts (title) VALUES ('p1');",
	].join('\n');
	const posts = sql`SELECT title FROM posts`;

	test(`a migration grants the right to switch to ${APP_ROLE_PLACEHOLDER}: asRole() switches, other statements do not get the role`, async () => {
		const db = block({
			'001.sql': `${ROLE_SCHEMA}\n${OPEN_POSTS}\nGRANT authenticated TO ${APP_ROLE_PLACEHOLDER} WITH INHERIT FALSE, SET TRUE;`,
		});
		assert.deepStrictEqual(await db.asRole('authenticated', { sub: 'alice' }).query(titles), [{ title: 'a1' }]);
		assert.deepStrictEqual(await db.asRole('authenticated').query(posts), [{ title: 'p1' }]);
		assert.deepStrictEqual(await db.query(posts), [], 'outside asRole() the policy of the role does not apply');
	});

	test('without the grant, the log names the migration to add', async (t) => {
		const logged: string[] = [];
		t.mock.method(console, 'error', (message: string) => logged.push(message));
		const db = block({ '001.sql': ROLE_SCHEMA });
		await assert.rejects(db.asRole('authenticated').query(titles), { name: 'DatabaseConfigurationError' });
		assert.strictEqual(logged.length, 1);
		assert.match(
			logged[0],
			/Add a migration file with GRANT "authenticated" TO \$\{app_role\} WITH INHERIT FALSE, SET TRUE; \(the migration runner replaces/,
		);
		assert.doesNotMatch(logged[0], /CURRENT_USER/);
	});
});
