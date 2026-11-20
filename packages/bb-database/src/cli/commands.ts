// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { promises as dns } from 'node:dns';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP, isIPv4 } from 'node:net';
import { dirname, resolve } from 'node:path';
import type { DatabaseEngine } from '../common/engine.js';
import {
	CONNECTION_NAME_PATTERN,
	CONNECTION_NAME_RULE,
	connectionParameterName,
	DEFAULT_CONNECTION_NAME,
	DEFAULT_SCHEMA,
} from '../constants.js';
import {
	assertCaPem,
	type ConnectionFields,
	localConnectionLabel,
	parseConnectionString,
} from '../external/connection.js';
import { externalEngine } from '../external/engine.js';
import { localConnectionSetting } from '../external/local-store.js';
import { readSsmConnectionString } from '../external/ssm-store.js';
import { buildMigrationPlan, connectionRole } from '../migrations/plan.js';
import {
	ledgerStatus,
	listMigrationFiles,
	loadMigrationFiles,
	markFilesApplied,
	runMigrationPlan,
} from '../migrations/runner.js';
import { confirm, note, readHidden, readStdin, remember, usageError } from './io.js';
import { TYPES_FILE, writeTypes } from './types-file.js';

export type Stage = 'sandbox' | 'production';

export interface CommonFlags {
	name: string;
	schema: string;
	noInput: boolean;
	yes: boolean;
}

/**
 * The module that holds the certificate authority of connection `name`. Each connection has its own, because two
 * databases can have two authorities; the default name keeps the plain file name.
 */
const caModuleOf = (name: string): string =>
	name === DEFAULT_CONNECTION_NAME ? 'cdk-blocks/database.ca.ts' : `cdk-blocks/database.${name}.ca.ts`;
const DEFAULT_MIGRATIONS_DIR = './migrations';
const PG_16 = 160000;

function checkName(name: string): void {
	if (!CONNECTION_NAME_PATTERN.test(name)) {
		throw usageError(`--name ${CONNECTION_NAME_RULE}.`);
	}
}

function readCaFile(path: string): string {
	let pem: string;
	try {
		pem = readFileSync(path, 'utf8');
	} catch {
		throw usageError(`--ca: cannot read ${path}.`);
	}
	assertCaPem(pem, `--ca ${path}`);
	return pem;
}

// The certificate authority a `connect --ca` wrote for the app, for this connection. Every verb reads it back
// from that file, so it verifies the server the same way without the flag.
function storedCa(name: string): string | undefined {
	const module = caModuleOf(name);
	if (!existsSync(module)) return undefined;
	const match = /export const DATABASE_CA = ("(?:[^"\\]|\\.)*");/.exec(readFileSync(module, 'utf8'));
	return match ? (JSON.parse(match[1]) as string) : undefined;
}

function writeCaModule(name: string, pem: string): string {
	const module = caModuleOf(name);
	mkdirSync(dirname(module), { recursive: true });
	writeFileSync(
		module,
		'// Written by `npm run db -- connect --ca`. The certificate authority that signed the database server\n' +
			'// certificate: a public certificate, safe to commit. Pass it as `ca` to DatabaseCluster.fromExisting().\n' +
			`export const DATABASE_CA = ${JSON.stringify(pem)};\n`,
	);
	return module;
}

async function stackNameFor(stage: Stage): Promise<string> {
	const { getStackName } = await import('@aws-cdk-blocks/core/scripts');
	return getStackName({ sandbox: stage === 'sandbox', projectRoot: process.cwd() });
}

async function ssmClient() {
	const [{ SSMClient }, { resolveDeploymentTarget }] = await Promise.all([
		import('@aws-sdk/client-ssm'),
		import('@aws-cdk-blocks/core/scripts'),
	]);
	const target = await resolveDeploymentTarget({ projectRoot: process.cwd() });
	return new SSMClient({ region: target.region ?? undefined, profile: target.profile });
}

/** The stored connection string of `name`: the stage's SSM parameter, or the local value. */
async function storedValue(name: string, stage: Stage | undefined): Promise<{ value: string | null; label: string }> {
	if (!stage) return { value: await localConnectionSetting(name).get(), label: localConnectionLabel(name) };
	return readSsmConnectionString(connectionParameterName(await stackNameFor(stage), name), await ssmClient());
}

interface Opened {
	engine: DatabaseEngine & { destroy(): Promise<void> };
	connection: ConnectionFields;
}

function open(value: string | null, label: string, ca: string | undefined, schema: string): Opened {
	const connection = parseConnectionString(value, label);
	remember(connection.password, typeof value === 'string' ? value.trim() : undefined);
	return { engine: externalEngine(connection, { ca, schemaName: schema, poolSize: 1 }), connection };
}

/** Runs `fn` on the database of the stored connection `flags.name` (a stage's, or the local one), then closes it. */
async function withStored<T>(
	flags: CommonFlags,
	stage: Stage | undefined,
	fn: (opened: Opened) => Promise<T>,
): Promise<T> {
	const stored = await storedValue(flags.name, stage);
	const opened = open(stored.value, stored.label, storedCa(flags.name), flags.schema);
	try {
		return await fn(opened);
	} finally {
		await opened.engine.destroy().catch(() => {});
	}
}

// ── connect ──────────────────────────────────────────────────────────────────

export interface ConnectFlags extends CommonFlags {
	stage?: Stage;
	ca?: string;
	valueStdin: boolean;
	checkOnly: boolean;
}

type PoolerMode = 'direct' | 'session' | 'transaction';

export interface ConnectResult {
	ok: true;
	name: string;
	stored: 'local' | 'ssm' | 'none';
	parameterName?: string;
	caModule?: string;
	tls: { verified: true; trust: 'ca' | 'system' };
	host: { ipv4: boolean };
	server: { version: string };
	role: { name: string; superuser: boolean; bypassRls: boolean; canSetRole: string[] };
	pooler?: { provider: 'supabase'; mode: PoolerMode };
	policies: { usingAuthFunctions: { table: string; policy: string }[] };
	warnings: string[];
}

// Supabase names its endpoints by host and port; no query tells a client which pooling mode it is on.
function supabasePooler(connection: ConnectionFields): ConnectResult['pooler'] {
	const host = connection.host.toLowerCase();
	if (host.endsWith('.pooler.supabase.com')) {
		return { provider: 'supabase', mode: connection.port === 6543 ? 'transaction' : 'session' };
	}
	if (/^db\.[a-z0-9]+\.supabase\.co$/.test(host)) {
		return { provider: 'supabase', mode: connection.port === 6543 ? 'transaction' : 'direct' };
	}
	return undefined;
}

async function hasIpv4(host: string): Promise<boolean> {
	if (isIP(host)) return isIPv4(host);
	try {
		return (await dns.resolve4(host)).length > 0;
	} catch {
		return false;
	}
}

export async function connect(flags: ConnectFlags): Promise<ConnectResult> {
	checkName(flags.name);
	// Without the flag, the authority an earlier `connect --ca` wrote for this connection still applies: the app
	// passes that module as `ca`, so the check here must be the one the app makes.
	const ca = flags.ca ? readCaFile(flags.ca) : storedCa(flags.name);
	let value: string;
	if (flags.valueStdin) value = await readStdin();
	else if (flags.noInput)
		throw usageError('With --no-input, pass the connection string on stdin with --value-stdin.');
	else value = await readHidden('Connection string: ');
	if (!value) throw usageError('No connection string was given.');
	remember(value);

	const label = 'The connection string';
	const { engine, connection } = open(value, label, ca, flags.schema);
	const warnings: string[] = [];
	try {
		const ipv4 = await hasIpv4(connection.host);
		if (!ipv4) {
			warnings.push(
				`${connection.host} has no IPv4 address. An AWS Lambda function outside a VPC has no IPv6 route and cannot reach it.`,
			);
		}
		// The first statement opens the connection: a certificate that does not verify, or a refused login, stops here.
		const [{ server_version: version }] = await engine.query<{ server_version: string }>('SHOW server_version');
		const [{ num }] = await engine.query<{ num: string }>("SELECT current_setting('server_version_num') AS num");
		const [role] = await engine.query<{ name: string; superuser: boolean; bypass: boolean }>(
			'SELECT r.rolname AS name, r.rolsuper AS superuser, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user',
		);
		// PostgreSQL 16 separates being a member of a role from being allowed to SET ROLE to it.
		const privilege = Number(num) >= PG_16 ? 'SET' : 'MEMBER';
		const roles = await engine.query<{ rolname: string }>(
			`SELECT r.rolname FROM pg_roles r
			  WHERE r.rolname <> current_user AND r.rolname !~ '^pg_' AND pg_has_role(current_user, r.oid, '${privilege}')
			  ORDER BY r.rolname`,
		);
		const policies = await engine.query<{ table: string; policy: string }>(
			`SELECT tablename AS "table", policyname AS policy FROM pg_policies
			  WHERE schemaname = $1 AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ 'auth\\.(uid|email|role)\\(\\)'
			  ORDER BY tablename, policyname`,
			[flags.schema],
		);
		const pooler = supabasePooler(connection);
		if (role.superuser || role.bypass) {
			warnings.push(
				`The role ${role.name} is not filtered by row-level security policies. A statement outside asRole() reads every row.`,
			);
		}
		if (policies.length > 0) {
			warnings.push(
				`Policies on ${[...new Set(policies.map((p) => p.table))].join(', ')} call auth.uid(), auth.email() or auth.role(). ` +
					'They match when the claims given to asRole() carry the Supabase user id as `sub`.',
			);
		}
		if (flags.stage && pooler && pooler.mode !== 'transaction') {
			warnings.push(
				`This is the Supabase ${pooler.mode === 'direct' ? 'direct connection' : 'session pooler'}. For a deployed stage, ` +
					'use the transaction pooler string (port 6543): every function instance holds connections.',
			);
		}
		if (flags.schema !== DEFAULT_SCHEMA && pooler?.mode === 'transaction') {
			warnings.push(
				`Schema ${flags.schema} needs a session setting (search_path), which a transaction pooler does not keep. ` +
					'Use schema-qualified names, or a direct or session-mode string.',
			);
		}

		const result: ConnectResult = {
			ok: true,
			name: flags.name,
			stored: 'none',
			tls: { verified: true, trust: ca ? 'ca' : 'system' },
			host: { ipv4 },
			server: { version },
			role: {
				name: role.name,
				superuser: role.superuser,
				bypassRls: role.bypass,
				canSetRole: roles.map((r) => r.rolname),
			},
			...(pooler ? { pooler } : {}),
			policies: { usingAuthFunctions: policies },
			warnings,
		};
		if (flags.checkOnly) return result;

		if (flags.stage) {
			const parameterName = connectionParameterName(await stackNameFor(flags.stage), flags.name);
			const { PutParameterCommand } = await import('@aws-sdk/client-ssm');
			await (await ssmClient()).send(
				new PutParameterCommand({ Name: parameterName, Value: value, Type: 'SecureString', Overwrite: true }),
			);
			result.stored = 'ssm';
			result.parameterName = parameterName;
		} else {
			await localConnectionSetting(flags.name).put(value);
			result.stored = 'local';
		}
		if (ca) result.caModule = flags.ca ? writeCaModule(flags.name, ca) : caModuleOf(flags.name);
		return result;
	} finally {
		await engine.destroy().catch(() => {});
	}
}

/** The lines `connect` prints for the app's backend file. */
/**
 * The block as the backend file declares it for this connection. `migrationsPath` is the directory that
 * `migrate` applies: the block's own default is another one (`cdk-blocks/migrations/<id>`), and a deploy runs
 * only the files of the directory the block names. An explicit path must exist, so it is a comment until it does.
 */
export function linesToPaste(
	result: ConnectResult,
	hasMigrationsDir: boolean = existsSync(DEFAULT_MIGRATIONS_DIR),
): string {
	const ca = result.caModule ? ', ca: DATABASE_CA' : '';
	const module = result.caModule?.replace(/^cdk-blocks\//, './').replace(/\.ts$/, '.js');
	return [
		...(module ? [`import { DATABASE_CA } from '${module}';`] : []),
		"const db = new Database(scope, 'db', {",
		`  cluster: DatabaseCluster.fromExisting({ name: '${result.name}'${ca} }),`,
		hasMigrationsDir
			? `  migrationsPath: '${DEFAULT_MIGRATIONS_DIR}',`
			: `  // migrationsPath: '${DEFAULT_MIGRATIONS_DIR}', // add with your first migration file`,
		'});',
	].join('\n');
}

// ── migrate, types, status ───────────────────────────────────────────────────

function migrationsDir(dir: string | undefined): string {
	const path = resolve(dir ?? DEFAULT_MIGRATIONS_DIR);
	if (!existsSync(path))
		throw usageError(`The migrations directory ${dir ?? DEFAULT_MIGRATIONS_DIR} does not exist.`);
	return path;
}

export interface MigrateFlags extends CommonFlags {
	dir?: string;
	/** `false` for `--no-types`. */
	types: string | false;
}

export interface MigrateResult {
	ok: true;
	host: string;
	applied: string[];
	types?: string;
}

export async function migrate(flags: MigrateFlags): Promise<MigrateResult> {
	checkName(flags.name);
	const dir = migrationsDir(flags.dir);
	return withStored(flags, undefined, async ({ engine, connection }) => {
		const files = loadMigrationFiles(dir);
		if (!flags.yes) {
			if (flags.noInput) throw usageError('With --no-input, pass --yes to apply the files without the question.');
			const { pending } = await ledgerStatus(engine.query.bind(engine), flags.schema, Object.keys(files));
			if (pending.length === 0) return { ok: true, host: connection.host, applied: [] };
			if (
				!(await confirm(
					`Apply ${pending.length} file(s) to ${connection.host}, database ${connection.database}?`,
				))
			) {
				throw usageError('Nothing was applied.');
			}
		}
		const plan = buildMigrationPlan(files, 'external', await connectionRole(engine));
		const { applied } = await runMigrationPlan(engine, plan, { schemaName: flags.schema, log: note });
		const result: MigrateResult = { ok: true, host: connection.host, applied };
		if (flags.types !== false)
			result.types = (await writeTypes(engine, flags.schema, flags.types || TYPES_FILE)).out;
		return result;
	});
}

export interface MarkAppliedFlags extends CommonFlags {
	dir?: string;
	/** File names, as `status` lists them. */
	files: string[];
	stage?: Stage;
}

export interface MarkAppliedResult {
	ok: true;
	host: string;
	marked: string[];
	alreadyApplied: string[];
}

/**
 * Records files as applied without running them. For a file that describes what the database already has
 * (a schema dump taken from it): it would fail if it ran there, and every database made later needs it.
 */
export async function markApplied(flags: MarkAppliedFlags): Promise<MarkAppliedResult> {
	checkName(flags.name);
	const known = listMigrationFiles(migrationsDir(flags.dir));
	const files = [...new Set(flags.files)].sort();
	const unknown = files.filter((file) => !known.includes(file));
	if (unknown.length > 0) {
		throw usageError(
			`Not a file of ${flags.dir ?? DEFAULT_MIGRATIONS_DIR}: ${unknown.join(', ')}. ` +
				'Pass the file name as `status` lists it.',
		);
	}
	if (!flags.yes && flags.noInput) {
		throw usageError('With --no-input, pass --yes to record the files without the question.');
	}
	return withStored(flags, flags.stage, async ({ engine, connection }) => {
		if (
			!flags.yes &&
			!(await confirm(
				`Record ${files.length} file(s) as applied on ${connection.host}, database ${connection.database}, ` +
					'without running them?',
			))
		) {
			throw usageError('Nothing was recorded.');
		}
		const marked = await markFilesApplied(engine, flags.schema, files);
		return {
			ok: true,
			host: connection.host,
			marked,
			alreadyApplied: files.filter((file) => !marked.includes(file)),
		};
	});
}

export interface TypesFlags extends CommonFlags {
	out?: string;
}

export interface TypesResult {
	ok: true;
	out: string;
	tables: string[];
}

export async function types(flags: TypesFlags): Promise<TypesResult> {
	checkName(flags.name);
	return withStored(flags, undefined, async ({ engine }) => ({
		ok: true,
		...(await writeTypes(engine, flags.schema, flags.out ?? TYPES_FILE)),
	}));
}

export interface StatusFlags extends CommonFlags {
	dir?: string;
	stage?: Stage;
}

export interface StatusResult {
	ok: true;
	applied: string[];
	pending: string[];
	/** Why the lists may differ from what a running process has. */
	note?: string;
}

export async function status(flags: StatusFlags): Promise<StatusResult> {
	checkName(flags.name);
	const files = listMigrationFiles(migrationsDir(flags.dir));
	return withStored(flags, flags.stage, async ({ engine }) => ({
		ok: true,
		...(await ledgerStatus(engine.query.bind(engine), flags.schema, files)),
	}));
}
