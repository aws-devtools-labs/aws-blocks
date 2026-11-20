// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// DSQL rejects a schema-level grant on `public` (a system entity): the deploy that pinned this ran
// `GRANT USAGE ON SCHEMA "public"`.
import assert from 'node:assert';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { sql } from '../common/sql.js';
import { APP_ROLE_PLACEHOLDER } from '../constants.js';
import { serializationConflict } from '../errors.js';
import { DatabaseCore } from '../runtime/index.js';
import { registerInternalAccess } from '../runtime/internal.js';
import { roleDatabase } from '../runtime/scoped.js';
import { ROLE_TODOS } from '../test-support/fixtures.js';
import { PgliteSession } from '../test-support/pglite-session.js';
import { RecordingEngine } from '../test-support/recording-engine.js';
import { ScriptedEngine } from '../test-support/scripted-engine.js';
import { ensureAppRole, grantAppRole, isRetryableMigrationError, migrateCluster } from './migration-lambda.js';

const ARN = 'arn:aws:iam::123:role/app';

class GrantEngine extends RecordingEngine {
	constructor(
		private readonly tables: string[] = [],
		private readonly matviews: string[] = [],
	) {
		super();
	}

	protected override answer(sql: string): unknown[] {
		if (/FROM pg_tables/.test(sql)) return this.tables.map((tablename) => ({ tablename }));
		if (/FROM pg_matviews/.test(sql)) return this.matviews.map((matviewname) => ({ matviewname }));
		return [];
	}
}

// Both halves, in the order a deploy runs them around the migration plan.
async function provisionAppRole(
	engine: RecordingEngine,
	kind: 'dsql' | 'aurora',
	role: string,
	arn: string,
	schemaName: string,
): Promise<void> {
	await ensureAppRole(engine, kind, role, arn);
	await grantAppRole(engine, role, schemaName);
}

describe('ensureAppRole and grantAppRole', () => {
	test('does not grant on schema public (DSQL rejects it as a system entity)', async () => {
		const engine = new GrantEngine(['notes']);
		await provisionAppRole(engine, 'dsql', 'blocks_app_x', ARN, 'public');
		assert.ok(!engine.statements.some((s) => s.includes('ON SCHEMA')), engine.statements.join('\n'));
		assert.ok(engine.statements.some((s) => s.startsWith('CREATE ROLE')));
		assert.ok(engine.statements.some((s) => s.startsWith('AWS IAM GRANT')));
		assert.ok(
			engine.statements.some((s) => s.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."notes"')),
		);
	});

	test('grants usage on a block-owned schema', async () => {
		const engine = new GrantEngine();
		await provisionAppRole(engine, 'dsql', 'blocks_app_x', ARN, 'app_dbxa');
		assert.ok(engine.statements.includes('GRANT USAGE ON SCHEMA "app_dbxa" TO "blocks_app_x"'));
	});

	test('a materialized view gets SELECT like a view', async () => {
		const engine = new GrantEngine(['notes'], ['daily']);
		await provisionAppRole(engine, 'aurora', 'blocks_app_x', ARN, 'app_dbxa');
		assert.ok(
			engine.statements.includes('GRANT SELECT ON "app_dbxa"."daily" TO "blocks_app_x"'),
			engine.statements.join('\n'),
		);
	});

	test('on an aurora cluster the role joins rds_iam instead of an AWS IAM GRANT', async () => {
		const engine = new GrantEngine(['notes']);
		await provisionAppRole(engine, 'aurora', 'blocks_app_x', ARN, 'app_dbxa');
		assert.ok(engine.statements.includes('GRANT rds_iam TO "blocks_app_x"'), engine.statements.join('\n'));
		assert.ok(!engine.statements.some((s) => s.startsWith('AWS IAM GRANT')));
		assert.ok(engine.statements.includes('GRANT USAGE ON SCHEMA "app_dbxa" TO "blocks_app_x"'));
		assert.ok(
			engine.statements.some((s) => s.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON "app_dbxa"."notes"')),
		);
	});
});

describe('isRetryableMigrationError', () => {
	test('a serialization conflict, on the error or its cause, is retried like a lost connection', () => {
		assert.ok(isRetryableMigrationError(serializationConflict(new Error('could not serialize access'))));
		assert.ok(
			isRetryableMigrationError(new Error('migration failed', { cause: serializationConflict(new Error('x')) })),
		);
		assert.ok(!isRetryableMigrationError(new Error('syntax error at or near "CREAT"')));
	});

	test('a server that is full or still starting, and a name that did not resolve yet, are retried', () => {
		for (const code of ['53300', '57P03', 'EAI_AGAIN', 'ETIMEDOUT']) {
			const driver = Object.assign(new Error('refused for now'), { code });
			const wrapped = new Error('Migration 001 failed', {
				cause: new Error('The database connection failed', { cause: driver }),
			});
			assert.ok(isRetryableMigrationError(wrapped), code);
		}
	});

	test('a refused login, a missing database and a certificate that does not verify are not retried', () => {
		for (const code of ['28P01', '3D000', 'ECONNREFUSED', 'SELF_SIGNED_CERT_IN_CHAIN']) {
			const driver = Object.assign(new Error('refused'), { code });
			assert.ok(!isRetryableMigrationError(new Error('The database connection failed', { cause: driver })), code);
		}
	});

	test('a dead socket or a connect timeout is retried, however deeply the runner and engine wrapped it', () => {
		const socket = new Error('Connection terminated unexpectedly');
		const wrapped = new Error('Migration 001 failed', {
			cause: new Error('The database query failed', { cause: socket }),
		});
		assert.ok(isRetryableMigrationError(wrapped));
		assert.ok(isRetryableMigrationError(new Error('timeout exceeded when trying to connect')));
		assert.ok(!isRetryableMigrationError(new Error('outer', { cause: new Error('relation "t" does not exist') })));
	});
});

// The deploy that pinned this: on the first deploy of an aurora cluster, a migration that granted a role to the
// app role found no app role, because the Lambda created it after the migrations; every asRole() call then
// failed until a second deploy.
describe('migrateCluster on a first deploy', () => {
	const APP_ROLE = 'blocks_app_main';
	const role = { dbRole: APP_ROLE, appRoleArn: ARN };
	let template: PgliteSession;
	let admin: PgliteSession;

	before(async () => {
		template = await PgliteSession.open();
		// Aurora's IAM login role, which PGlite does not have.
		await template.execute('CREATE ROLE rds_iam');
	});
	after(() => template.close());

	// A fresh cluster per test, copied from the template: roles belong to the cluster, not to a schema.
	beforeEach(async () => {
		admin = await template.clone();
	});
	afterEach(() => admin.close());

	// The app's connection: it logs in as the app role, and asRole() switches from there.
	function asRole(name: string, claims?: Record<string, unknown>) {
		const core = new DatabaseCore({ engine: async () => admin.as(APP_ROLE) });
		const parent = { cluster: { kind: 'aurora' as const, id: 'main' }, schemaName: 'public', fullId: 'app-db' };
		registerInternalAccess(parent, {
			engine: () => core.getEngine(),
			session: () => core.session(),
			simulateConflict: () => {},
			migrationsPath: undefined,
		});
		return roleDatabase(parent, name, claims);
	}
	const titles = sql`SELECT title FROM todos ORDER BY id`;

	test('a migration that grants a role to the app role by name succeeds, and asRole() can switch to it', async () => {
		const files = { '001_todos.sql': `${ROLE_TODOS}\nGRANT authenticated TO "${APP_ROLE}";` };
		assert.strictEqual(await migrateCluster(admin, 'aurora', files, role, 'public'), true);
		const rows = await asRole('authenticated', { sub: 'alice' }).query<{ title: string }>(titles);
		assert.deepStrictEqual(rows, [{ title: 'a1' }]);
	});

	test(`${APP_ROLE_PLACEHOLDER} in a migration names the app role`, async () => {
		const files = { '001_todos.sql': `${ROLE_TODOS}\nGRANT authenticated TO ${APP_ROLE_PLACEHOLDER};` };
		assert.strictEqual(await migrateCluster(admin, 'aurora', files, role, 'public'), true);
		const members = await admin.query<{ member: string }>(
			"SELECT m.rolname AS member FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE r.rolname = 'authenticated'",
		);
		assert.deepStrictEqual(members, [{ member: APP_ROLE }]);
		const rows = await asRole('authenticated', { sub: 'bob' }).query<{ title: string }>(titles);
		assert.deepStrictEqual(rows, [{ title: 'b1' }]);
	});

	test('a deploy after a failed file finds the role in place and runs the file again', async () => {
		const first = {
			'001_todos.sql': ROLE_TODOS,
			'002_grant.sql': `GRANT authenticated TO ${APP_ROLE_PLACEHOLDER};\nSELECT * FROM missing;`,
		};
		await assert.rejects(migrateCluster(admin, 'aurora', first, role, 'public'), {
			name: 'MigrationFailedException',
			message: /002_grant\.sql failed/,
		});
		// The role was created before the files ran; the failed file left nothing.
		assert.deepStrictEqual(await admin.query('SELECT rolname FROM pg_roles WHERE rolname = $1', [APP_ROLE]), [
			{ rolname: APP_ROLE },
		]);
		await assert.rejects(asRole('authenticated').query(titles), { name: 'DatabaseConfigurationError' });

		const fixed = { ...first, '002_grant.sql': `GRANT authenticated TO ${APP_ROLE_PLACEHOLDER};` };
		assert.strictEqual(await migrateCluster(admin, 'aurora', fixed, role, 'public'), true);
		const rows = await asRole('authenticated', { sub: 'alice' }).query<{ title: string }>(titles);
		assert.deepStrictEqual(rows, [{ title: 'a1' }]);
	});
});

// What the app role is given, statement for statement: the same set as before the role was created ahead of the
// migrations. Only the order changed: the role and its IAM mapping first, the schema grants after the files.
describe('migrateCluster gives the app role the same privileges', () => {
	const role = { dbRole: 'blocks_app_x', appRoleArn: ARN };
	const files = { '001_notes.sql': 'CREATE TABLE notes (id INT PRIMARY KEY);' };
	const isRoleStatement = (s: string) => /^(CREATE ROLE|GRANT|AWS IAM GRANT)\b/.test(s);

	for (const kind of ['aurora', 'dsql'] as const) {
		test(`on ${kind}: the role and its IAM mapping before the files, the schema grants after`, async () => {
			const engine = new GrantEngine(['notes'], ['daily']);
			assert.strictEqual(await migrateCluster(engine, kind, files, role, 'app_x'), true);
			const mapping =
				kind === 'dsql' ? `AWS IAM GRANT "blocks_app_x" TO '${ARN}'` : 'GRANT rds_iam TO "blocks_app_x"';
			assert.deepStrictEqual(engine.statements.filter(isRoleStatement), [
				'CREATE ROLE "blocks_app_x" WITH LOGIN',
				mapping,
				'GRANT USAGE ON SCHEMA "app_x" TO "blocks_app_x"',
				'GRANT SELECT, INSERT, UPDATE, DELETE ON "app_x"."notes" TO "blocks_app_x"',
				'GRANT SELECT ON "app_x"."daily" TO "blocks_app_x"',
			]);
			const at = (s: string) => engine.statements.indexOf(s);
			const table = engine.statements.findIndex((s) => s.startsWith('CREATE TABLE notes'));
			assert.ok(at(mapping) < table && table < at('GRANT USAGE ON SCHEMA "app_x" TO "blocks_app_x"'));
		});
	}

	test('a block with no migrations gets the same grants', async () => {
		const engine = new GrantEngine(['notes']);
		assert.strictEqual(await migrateCluster(engine, 'aurora', undefined, role, 'app_x'), true);
		assert.deepStrictEqual(engine.statements.filter(isRoleStatement), [
			'CREATE ROLE "blocks_app_x" WITH LOGIN',
			'GRANT rds_iam TO "blocks_app_x"',
			'GRANT USAGE ON SCHEMA "app_x" TO "blocks_app_x"',
			'GRANT SELECT, INSERT, UPDATE, DELETE ON "app_x"."notes" TO "blocks_app_x"',
		]);
	});
});

// A DSQL cluster whose catalog also lists roles and the schema's objects.
class DsqlCluster extends ScriptedEngine {
	readonly roles = new Set<string>();

	protected override answer(sql: string, params: unknown[]): unknown[] {
		if (/FROM pg_roles/.test(sql)) return this.roles.has(String(params[0])) ? [{ rolname: params[0] }] : [];
		const created = /^CREATE ROLE "([^"]+)"/.exec(sql);
		if (created) {
			this.roles.add(created[1]);
			return [];
		}
		if (/FROM pg_tables/.test(sql)) return [{ tablename: 't' }];
		if (/FROM pg_(views|matviews|sequences)/.test(sql)) return [];
		return super.answer(sql, params);
	}
}

describe('migrateCluster while a DSQL job runs', () => {
	test('each poll finds the role in place; the schema grants come once the files are done', async () => {
		const engine = new DsqlCluster();
		const role = { dbRole: 'blocks_app_x', appRoleArn: ARN };
		const files = {
			'001_t.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY, n INT);\nCREATE INDEX ASYNC t_n ON t (n);',
			'002_grant.sql': `GRANT SELECT ON t TO ${APP_ROLE_PLACEHOLDER};`,
		};
		assert.strictEqual(await migrateCluster(engine, 'dsql', files, role, 'public'), false);
		assert.ok(engine.roles.has('blocks_app_x'), 'the role exists while the job runs');
		assert.ok(!engine.statements.some((s) => s.includes('ON "public"."t"')), 'no schema grant before the files');

		// The provider polls again; the job is still running, then it completes.
		assert.strictEqual(await migrateCluster(engine, 'dsql', files, role, 'public'), false);
		for (const job of engine.jobs.values()) job.status = 'completed';
		assert.strictEqual(await migrateCluster(engine, 'dsql', files, role, 'public'), true);

		assert.strictEqual(engine.statements.filter((s) => s.startsWith('CREATE ROLE')).length, 1);
		assert.ok(engine.statements.includes('GRANT SELECT ON t TO "blocks_app_x"'), engine.statements.join('\n'));
		assert.deepStrictEqual([...engine.migrations].sort(), ['001_t.sql', '002_grant.sql']);
		const last = engine.statements.lastIndexOf(
			'GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."t" TO "blocks_app_x"',
		);
		assert.ok(last > engine.statements.indexOf('GRANT SELECT ON t TO "blocks_app_x"'));
	});
});
