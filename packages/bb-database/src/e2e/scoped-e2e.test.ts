// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E test: a `Database` on an existing PostgreSQL, against a real Supabase database, with rows scoped to two
 * real Supabase Auth users.
 *
 * Ports the 14 cases of `packages/bb-data/src/crud/crud-e2e.test.ts` (list, where, orderBy, limit, select,
 * like, get, create, update, delete, and the isolation of the two users). Each `db.crud()` call is the
 * equivalent Kysely statement on `new Kysely({ dialect: new DatabaseDialect(db.asRole('authenticated', claims)) })`.
 * The fixture's `todos` policy is `auth.uid() = user_id`, so the claims are the token's claims with the
 * Supabase user id as `sub`.
 *
 * The whole group runs two times: with the connection string as given (the Supabase shared pooler in session
 * mode, port 5432) and with the port changed to 6543 (transaction mode), where a scope that outlives its
 * transaction would reach another caller.
 *
 * Uses only the package entry, the Kysely entry and `@aws-cdk-blocks/core`. The block is built with the override
 * form of `DatabaseCluster.fromExisting()`; nothing is read from a settings store.
 *
 * Requires env vars:
 *   SUPABASE_PROJECT_REF, SUPABASE_ANON_KEY, SUPABASE_DB_URL,
 *   SUPABASE_TEST_USER_1_EMAIL, SUPABASE_TEST_USER_1_PASSWORD,
 *   SUPABASE_TEST_USER_2_EMAIL, SUPABASE_TEST_USER_2_PASSWORD
 *
 * Skips when they are not set. TLS is verified against the pinned CA (`DATABASE_CA_CERT`, or the fixture).
 *
 * Prerequisites on the Supabase project: `test/fixtures/supabase-e2e-schema.sql` applied
 * (`test/apply-schema.ts`), and two auth users. The tests create and remove their own rows; every row of a
 * run carries the run's tag in `content`, so a run on the same project at the same time does not change what
 * this one asserts.
 */
import assert from 'node:assert';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Database, DatabaseCluster, DatabaseErrors, sql } from '@aws-cdk-blocks/bb-database';
import { DatabaseDialect } from '@aws-cdk-blocks/bb-database/kysely';
import { isBlocksError, Scope } from '@aws-cdk-blocks/core';
import { type Generated, Kysely, sql as ksql, type Transaction } from 'kysely';
import { caPem, env, need, withPort } from './support.js';

const skip = !env.projectRef || !env.anonKey || !env.dbUrl || !env.user1Email || !env.user1Password;

/** What the application declares by hand for Kysely: the fixture's `todos` table. */
interface Tables {
	todos: {
		id: Generated<string>;
		user_id: string;
		content: string;
		done: Generated<boolean>;
	};
}

interface Todo {
	id: string;
	user_id: string;
	content: string;
	done: boolean;
}

interface SupabaseUser {
	userId: string;
	claims: Record<string, unknown>;
}

/** Sign in to Supabase Auth and return the user id and the claims of the access token. */
async function signIn(email: string, password: string): Promise<SupabaseUser> {
	const url = `https://${need(env.projectRef, 'SUPABASE_PROJECT_REF')}.supabase.co/auth/v1/token?grant_type=password`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', apikey: need(env.anonKey, 'SUPABASE_ANON_KEY') },
		body: JSON.stringify({ email, password }),
	});
	// The status only: the body of a refused sign-in is not for a log.
	if (!res.ok) throw new Error(`Supabase sign-in failed (${res.status})`);
	const data: { access_token: string; user: { id: string } } = await res.json();
	const claims: Record<string, unknown> = JSON.parse(
		Buffer.from(data.access_token.split('.')[1], 'base64url').toString(),
	);
	return { userId: data.user.id, claims };
}

/** The scope of a user as the design states it for a policy on `auth.uid()`: the token's claims, `sub` = the user id. */
const claimsOf = (user: SupabaseUser): Record<string, unknown> => ({ ...user.claims, sub: user.userId });

// Part of every `content` this run writes. Rows of another run on the same project never match it.
const RUN = `run-${process.pid}-${Date.now().toString(36)}`;
// The scope of the blocks of this file. Its id is this process's own, so what local mode keeps under
// `.cdk-blocks/local/data/` for it can be removed without touching the data of another process.
const SCOPE_ID = `bbdb-e2e-${process.pid}`;

const MODES = [
	{ id: 'session', label: 'session mode (the connection string as given)', port: undefined },
	{ id: 'transaction', label: 'transaction mode (port 6543)', port: '6543' },
];

for (const { id, label, port } of MODES) {
	describe(`Database on an existing PostgreSQL: scoped reads and writes on Supabase, ${label}`, { skip }, () => {
		const given = need(env.dbUrl, 'SUPABASE_DB_URL');
		const url = port ? withPort(given, port) : given;

		// Database ids are unique per app, so each group names its block after its mode.
		const db = new Database(new Scope(SCOPE_ID), id, {
			cluster: DatabaseCluster.fromExisting({ connectionString: { get: async () => url }, ca: caPem() }),
		});

		// The README's instance: one per database, on the block itself, created once and used by every user and
		// every request. An application has it at module scope.
		const kysely = new Kysely<Tables>({ dialect: new DatabaseDialect(db) });

		// The README recipe: the role and the claims are set in the transaction, with bound parameters.
		const asUser = <T>(user: SupabaseUser, fn: (trx: Transaction<Tables>) => Promise<T>): Promise<T> =>
			kysely.transaction().execute(async (trx) => {
				const claims = JSON.stringify(claimsOf(user));
				await ksql`
					select set_config('role', ${'authenticated'}, true),
					       set_config('request.jwt.claims', ${claims}, true)
				`.execute(trx);
				return fn(trx);
			});

		const scoped = (user: SupabaseUser) => db.asRole('authenticated', claimsOf(user));

		let user1: SupabaseUser;
		let user2: SupabaseUser;
		// A Kysely instance on each user's scoped database: what `db.crud()` with the `auth` callback was.
		let todos1: Kysely<Tables>;
		let todos2: Kysely<Tables>;
		// [0] 'Seed alpha' and [1] 'Seed beta' belong to user 1, [2] 'Seed gamma' to user 2.
		const seedIds: string[] = [];

		// Ends every `content` this group writes.
		const tag = `${RUN}-${id}`;
		const alpha = `Seed alpha ${tag}`;
		const beta = `Seed beta ${tag}`;
		const gamma = `Seed gamma ${tag}`;
		const mine = `%${tag}`;

		before(async () => {
			user1 = await signIn(
				need(env.user1Email, 'SUPABASE_TEST_USER_1_EMAIL'),
				need(env.user1Password, 'SUPABASE_TEST_USER_1_PASSWORD'),
			);
			user2 = await signIn(
				need(env.user2Email, 'SUPABASE_TEST_USER_2_EMAIL'),
				need(env.user2Password, 'SUPABASE_TEST_USER_2_PASSWORD'),
			);
			todos1 = new Kysely<Tables>({ dialect: new DatabaseDialect(scoped(user1)) });
			todos2 = new Kysely<Tables>({ dialect: new DatabaseDialect(scoped(user2)) });

			// Seed data for both users, each written as its user, so list/get/filter tests have rows to work with.
			const insert = (as: Kysely<Tables>, user: SupabaseUser, content: string, done: boolean) =>
				as
					.insertInto('todos')
					.values({ user_id: user.userId, content, done })
					.returning('id')
					.executeTakeFirstOrThrow();
			const s1 = await insert(todos1, user1, alpha, false);
			const s2 = await insert(todos1, user1, beta, true);
			const s3 = await insert(todos2, user2, gamma, false);
			seedIds.push(s1.id, s2.id, s3.id);
		});

		after(async () => {
			// Every row of this group, whichever test wrote it, as the connection role.
			await db.execute(sql`DELETE FROM todos WHERE content LIKE ${mine}`);
			// What local mode keeps on disk for the block of this group, if anything.
			const mockData = join(process.cwd(), '.cdk-blocks/local/data');
			if (existsSync(mockData)) {
				for (const entry of readdirSync(mockData)) {
					if (entry.startsWith(`${SCOPE_ID}-${id}`)) {
						rmSync(join(mockData, entry), { recursive: true, force: true });
					}
				}
			}
		});

		test('db.cluster is the external cluster reference', () => {
			assert.deepStrictEqual(db.cluster, { kind: 'external', id: 'external' });
		});

		// ─── The 14 cases of crud-e2e.test.ts ───────────────────────────────────

		test('list returns rows for user-1 only', async () => {
			const rows = await todos1.selectFrom('todos').selectAll().execute();
			assert.ok(rows.length > 0, 'Expected at least 1 row for user-1');
			for (const row of rows) {
				assert.strictEqual(row.user_id, user1.userId, 'All rows should belong to user-1');
			}
			const ids = rows.map((r) => r.id);
			assert.ok(ids.includes(seedIds[0]) && ids.includes(seedIds[1]), 'both seed rows of user-1 are listed');
		});

		test('list with where filter (content equality)', async () => {
			const rows = await todos1.selectFrom('todos').selectAll().where('content', '=', alpha).execute();
			assert.deepStrictEqual(rows, [{ id: seedIds[0], user_id: user1.userId, content: alpha, done: false }]);
		});

		test('list with orderBy', async () => {
			// The rows of this run only, so that the order does not depend on how the database collates the
			// content of another run.
			const asc = await todos1
				.selectFrom('todos')
				.select('content')
				.where('content', 'like', mine)
				.orderBy('content', 'asc')
				.execute();
			assert.deepStrictEqual(asc, [{ content: alpha }, { content: beta }], 'Should be ordered by content asc');
			const desc = await todos1
				.selectFrom('todos')
				.select('content')
				.where('content', 'like', mine)
				.orderBy('content', 'desc')
				.execute();
			assert.deepStrictEqual(desc, [{ content: beta }, { content: alpha }], 'and by content desc');
		});

		test('list with limit', async () => {
			const rows = await todos1.selectFrom('todos').selectAll().limit(1).execute();
			assert.strictEqual(rows.length, 1);
		});

		test('list with select of two columns', async () => {
			const rows = await todos1.selectFrom('todos').select(['id', 'user_id']).execute();
			assert.ok(rows.length > 0);
			for (const row of rows) {
				assert.deepStrictEqual(Object.keys(row).sort(), ['id', 'user_id'], 'only the selected columns');
			}
		});

		test('list with like operator', async () => {
			const rows = await todos1.selectFrom('todos').selectAll().where('content', 'like', 'Seed%').execute();
			assert.ok(rows.length >= 1);
			for (const row of rows) assert.ok(row.content.startsWith('Seed'), 'every row matches the pattern');
			const ids = rows.map((r) => r.id);
			assert.ok(ids.includes(seedIds[0]) && ids.includes(seedIds[1]), 'both seed rows of user-1 match');
			assert.ok(!ids.includes(seedIds[2]), 'the seed row of user-2 matches the pattern and is not returned');
		});

		test('get returns single row', async () => {
			const row = await todos1.selectFrom('todos').selectAll().where('id', '=', seedIds[0]).executeTakeFirst();
			assert.strictEqual(row?.id, seedIds[0]);
			assert.strictEqual(row?.content, alpha);
		});

		test('get returns no row for other user row (RLS)', async () => {
			// seedIds[2] belongs to user2
			const row = await todos1.selectFrom('todos').selectAll().where('id', '=', seedIds[2]).executeTakeFirst();
			assert.strictEqual(row, undefined);
		});

		test('create inserts and returns row', async () => {
			const content = `E2E crud test ${tag}`;
			const row = await todos1
				.insertInto('todos')
				.values({ user_id: user1.userId, content, done: false })
				.returningAll()
				.executeTakeFirstOrThrow();
			assert.ok(row.id, 'Should have auto-generated id');
			assert.strictEqual(row.content, content);
			assert.strictEqual(row.user_id, user1.userId);
			assert.strictEqual(row.done, false);
		});

		test('update updates and returns row', async () => {
			const updated = `Seed alpha updated ${tag}`;
			const row = await todos1
				.updateTable('todos')
				.set({ content: updated })
				.where('id', '=', seedIds[0])
				.returningAll()
				.executeTakeFirst();
			assert.strictEqual(row?.id, seedIds[0]);
			assert.strictEqual(row?.content, updated);
			// Restore original content for other tests
			const restored = await todos1
				.updateTable('todos')
				.set({ content: alpha })
				.where('id', '=', seedIds[0])
				.executeTakeFirst();
			assert.strictEqual(restored.numUpdatedRows, 1n);
		});

		test('update changes nothing for other user row (RLS)', async () => {
			const row = await todos1
				.updateTable('todos')
				.set({ content: `hacked ${tag}` })
				.where('id', '=', seedIds[2])
				.returningAll()
				.executeTakeFirst();
			assert.strictEqual(row, undefined);
			const kept = await db.queryOne<{ content: string }>(
				sql`SELECT content FROM todos WHERE id = ${seedIds[2]}`,
			);
			assert.deepStrictEqual(kept, { content: gamma }, 'the row of user-2 is unchanged');
		});

		test('delete deletes own row', async () => {
			// Create a throwaway row to delete
			const tmp = await todos1
				.insertInto('todos')
				.values({ user_id: user1.userId, content: `to-delete ${tag}`, done: false })
				.returningAll()
				.executeTakeFirstOrThrow();
			const result = await todos1.deleteFrom('todos').where('id', '=', tmp.id).executeTakeFirst();
			assert.strictEqual(result.numDeletedRows, 1n);
			const row = await todos1.selectFrom('todos').selectAll().where('id', '=', tmp.id).executeTakeFirst();
			assert.strictEqual(row, undefined);
		});

		test('delete cannot delete other user row (RLS)', async () => {
			const result = await todos1.deleteFrom('todos').where('id', '=', seedIds[2]).executeTakeFirst();
			assert.strictEqual(result.numDeletedRows, 0n);
			const kept = await db.queryOne<{ id: string }>(sql`SELECT id FROM todos WHERE id = ${seedIds[2]}`);
			assert.deepStrictEqual(kept, { id: seedIds[2] }, 'the row of user-2 is still there');
		});

		test('user-2 isolation: sees only own rows', async () => {
			const user1Rows = await todos1.selectFrom('todos').selectAll().execute();
			const user2Rows = await todos2.selectFrom('todos').selectAll().execute();

			assert.ok(user2Rows.length > 0, 'user-2 should have rows');
			const user1Ids = new Set(user1Rows.map((r) => r.id));
			for (const row of user2Rows) {
				assert.ok(!user1Ids.has(row.id), 'user-2 should not see user-1 rows');
				assert.strictEqual(row.user_id, user2.userId);
			}
			assert.ok(
				user2Rows.some((r) => r.id === seedIds[2]),
				'user-2 sees its seed row',
			);
		});

		// ─── Cases the design adds ──────────────────────────────────────────────

		test('the block API without Kysely: asRole().query(), queryOne() and transaction() read as the user', async () => {
			const rows = await scoped(user1).query<Todo>(sql`SELECT id, user_id, content, done FROM todos`);
			assert.ok(rows.length > 0, 'Expected at least 1 row for user-1');
			for (const row of rows) assert.strictEqual(row.user_id, user1.userId, 'All rows should belong to user-1');
			const ids = rows.map((r) => r.id);
			assert.ok(ids.includes(seedIds[0]) && ids.includes(seedIds[1]), 'both seed rows of user-1 are read');

			const own = await scoped(user1).queryOne<Todo>(
				sql`SELECT id, user_id, content, done FROM todos WHERE id = ${seedIds[0]}`,
			);
			assert.deepStrictEqual(own, { id: seedIds[0], user_id: user1.userId, content: alpha, done: false });
			const other = await scoped(user1).queryOne<{ id: string }>(
				sql`SELECT id FROM todos WHERE id = ${seedIds[2]}`,
			);
			assert.strictEqual(other, null, 'the row of user-2 is not found');

			const inTransaction = await scoped(user2).transaction(async (tx) => {
				const who = await tx.queryOne<{ uid: string | null; role: string }>(
					sql`SELECT auth.uid()::text AS uid, current_user::text AS role`,
				);
				return { who, rows: await tx.query<Todo>(sql`SELECT id, user_id, content, done FROM todos`) };
			});
			assert.deepStrictEqual(inTransaction.who, { uid: user2.userId, role: 'authenticated' });
			assert.ok(inTransaction.rows.length > 0, 'user-2 should have rows');
			for (const row of inTransaction.rows) assert.strictEqual(row.user_id, user2.userId);
		});

		test('the README recipe: one Kysely instance on the block, each user set in its transaction', async () => {
			const readAs = async (user: SupabaseUser, own: string[], foreign: string[]) => {
				const rows = await asUser(user, (trx) => trx.selectFrom('todos').selectAll().execute());
				assert.ok(rows.length > 0, 'the user has rows');
				for (const row of rows) assert.strictEqual(row.user_id, user.userId, 'only the rows of the user');
				const ids = rows.map((r) => r.id);
				for (const id of own) assert.ok(ids.includes(id), 'the seed rows of the user are read');
				for (const id of foreign) assert.ok(!ids.includes(id), 'the seed rows of the other user are not');
			};
			await readAs(user1, [seedIds[0], seedIds[1]], [seedIds[2]]);
			await readAs(user2, [seedIds[2]], [seedIds[0], seedIds[1]]);
			// A write through the recipe is the user's too: the row comes back, and only to its owner.
			const content = `recipe ${tag}`;
			const written = await asUser(user2, (trx) =>
				trx
					.insertInto('todos')
					.values({ user_id: user2.userId, content })
					.returningAll()
					.executeTakeFirstOrThrow(),
			);
			assert.deepStrictEqual(written, { id: written.id, user_id: user2.userId, content, done: false });
			const seenByUser1 = await asUser(user1, (trx) =>
				trx.selectFrom('todos').select('id').where('content', '=', content).execute(),
			);
			assert.deepStrictEqual(seenByUser1, [], 'user-1 does not see the row user-2 wrote');
		});

		test('the README recipe: transactions of two users at the same time on the one instance', async () => {
			// More transactions than the pool has connections, the two users alternating, each one held open long
			// enough to overlap with the others.
			const results = await Promise.all(
				Array.from({ length: 12 }, (_, i) => {
					const user = i % 2 === 0 ? user1 : user2;
					return asUser(user, async (trx) => {
						const who = await ksql<{ uid: string | null; role: string }>`
							select auth.uid()::text as uid, current_user::text as role
						`.execute(trx);
						await ksql`select pg_sleep(0.05)`.execute(trx);
						const rows = await trx.selectFrom('todos').selectAll().execute();
						return { user, who: who.rows[0], rows };
					});
				}),
			);
			for (const { user, who, rows } of results) {
				assert.deepStrictEqual(who, { uid: user.userId, role: 'authenticated' });
				assert.ok(rows.length > 0, 'the user has rows');
				for (const row of rows) assert.strictEqual(row.user_id, user.userId, 'only the rows of the user');
				const expected = user === user1 ? [seedIds[0], seedIds[1]] : [seedIds[2]];
				const ids = rows.map((r) => r.id);
				for (const id of expected) assert.ok(ids.includes(id), 'the seed rows of the user are read');
			}
		});

		test('a statement on the block itself sees the seed rows of both users', async () => {
			const viaBlock = await db.query<{ id: string; user_id: string }>(
				sql`SELECT id, user_id FROM todos WHERE content LIKE ${`Seed %${tag}`} ORDER BY content`,
			);
			assert.deepStrictEqual(viaBlock, [
				{ id: seedIds[0], user_id: user1.userId },
				{ id: seedIds[1], user_id: user1.userId },
				{ id: seedIds[2], user_id: user2.userId },
			]);
			const viaKysely = await kysely
				.selectFrom('todos')
				.select(['id', 'user_id'])
				.where('id', 'in', seedIds)
				.orderBy('content', 'asc')
				.execute();
			assert.deepStrictEqual(viaKysely, viaBlock, 'the Kysely instance on the block reads the same rows');
		});

		test('after scoped statements, a statement on the block runs as the connection role with no claims', async () => {
			// Scoped work first, on every connection of the pool and through each scoped exit.
			await Promise.all(
				Array.from({ length: 10 }, (_, i) =>
					i % 2 === 0
						? scoped(user1).query<{ id: string }>(sql`SELECT id FROM todos`)
						: todos2.selectFrom('todos').select('id').execute(),
				),
			);
			await Promise.all(
				[user1, user2, user1, user2].map((user) =>
					asUser(user, (trx) => trx.selectFrom('todos').select('id').execute()),
				),
			);

			const identity = sql`
				SELECT current_user::text AS role, session_user::text AS login,
				       current_setting('request.jwt.claims', true) AS claims
			`;
			const plain = await Promise.all(
				Array.from({ length: 10 }, () =>
					db.queryOne<{ role: string; login: string; claims: string | null }>(identity),
				),
			);
			for (const row of plain) {
				assert.ok(row, 'the statement returns a row');
				assert.strictEqual(row.role, row.login, 'the role is the one the connection logged in as');
				assert.ok(row.role !== 'authenticated' && row.role !== 'anon', 'no scoped role is left');
				// PostgreSQL gives NULL for a setting the session never had, and '' after a transaction that set it.
				assert.ok(row.claims === null || row.claims === '', 'no claims are left on the connection');
			}
			const viaKysely = await ksql<{ role: string; login: string; claims: string | null }>`
				select current_user::text as role, session_user::text as login,
				       current_setting('request.jwt.claims', true) as claims
			`.execute(kysely);
			assert.strictEqual(viaKysely.rows[0]?.role, viaKysely.rows[0]?.login, 'the same on the Kysely instance');
			assert.ok(viaKysely.rows[0]?.claims === null || viaKysely.rows[0]?.claims === '');
		});

		test('a scoped insert with the user_id of another user is refused with PermissionDenied', async () => {
			const content = `forged ${tag}`;
			const denied = (e: unknown) => isBlocksError(e, DatabaseErrors.PermissionDenied);
			await assert.rejects(
				todos1.insertInto('todos').values({ user_id: user2.userId, content, done: false }).execute(),
				denied,
				'through Kysely on the scoped database',
			);
			await assert.rejects(
				scoped(user1).execute(sql`INSERT INTO todos (user_id, content) VALUES (${user2.userId}, ${content})`),
				denied,
				'through execute() on the scoped database',
			);
			const written = await db.query<{ id: string }>(sql`SELECT id FROM todos WHERE content = ${content}`);
			assert.deepStrictEqual(written, [], 'no row was written');
		});

		test("asRole('anon') reads no todos rows", async () => {
			const anon = db.asRole('anon');
			assert.deepStrictEqual(await anon.queryOne<{ role: string }>(sql`SELECT current_user::text AS role`), {
				role: 'anon',
			});
			assert.deepStrictEqual(await anon.query<Todo>(sql`SELECT id, user_id, content, done FROM todos`), []);
			const viaKysely = new Kysely<Tables>({ dialect: new DatabaseDialect(anon) });
			assert.deepStrictEqual(await viaKysely.selectFrom('todos').selectAll().execute(), []);
		});
	});
}
