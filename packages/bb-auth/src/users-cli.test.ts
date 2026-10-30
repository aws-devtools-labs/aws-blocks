// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `npx @aws-blocks/bb-auth users …` — the supported way to make the first admin.
 *
 * The local path runs against a real local pool (`Auth` from the mock entry,
 * persisted to `.bb-data/`), and a second `Auth` instance with the same id —
 * what a restarted dev server constructs — checks that `requireRole` sees the
 * change. The deployed path runs SDK clients whose `send` is replaced, so the
 * exact CloudFormation and Cognito calls are pinned without AWS.
 */

import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { STSClient } from '@aws-sdk/client-sts';
import { ApiError } from '@aws-blocks/core';
import { AuthErrors } from './errors.js';
import { Auth } from './index.mock.js';
import { Browser } from './test-helpers.js';
import type { DeployedClients } from './users-cli/deployed.js';
import { parseUsersArgs, runUsersCli, type UsersCliDeps } from './users-cli/cli.js';
import { PACKAGE_DIR } from './test-support/typecheck.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';

/** Run the CLI, capturing its output. */
async function cli(argv: string[], deps: UsersCliDeps = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runUsersCli(argv, {
		isPidAlive: () => false,
		...deps,
		log: (l) => out.push(l),
		error: (l) => err.push(l),
	});
	return { code, out: out.join('\n'), err: err.join('\n') };
}

// ─────────────────────────────────────────────────────────────────────────────
// Local pool
// ─────────────────────────────────────────────────────────────────────────────

describe('users CLI: local pool', () => {
	let n = 0;
	let root: { id: string };
	beforeEach(() => {
		root = { id: `users-cli-${process.pid}-${++n}` };
	});

	// Codes reach the test through the local-only hook (keyed by block + user).
	const codes = new Map<string, string>();
	const makeAuth = (id = 'auth') =>
		new Auth(root, id, {
			users: { groups: ['admin', 'editors'] },
			codeDelivery: async (username, code) => {
				codes.set(`${id}:${username}`, code);
			},
		});

	async function register(auth: ReturnType<typeof makeAuth>, username: string, email: string) {
		await auth.signUp(username, PASSWORD, { attributes: { email } });
		const id = auth.fullId.slice(root.id.length + 1);
		const code = codes.get(`${id}:${username}`);
		assert.ok(code, `a sign-up code for ${username}`);
		await auth.confirmSignUp(username, code);
	}

	/** Whether `username` passes `requireRole(…, 'admin')` on a freshly loaded pool (a restarted dev server). */
	async function isAdmin(username: string): Promise<boolean> {
		const auth = makeAuth();
		const b = new Browser();
		await b.request((ctx) => auth.signIn(username, PASSWORD, ctx));
		try {
			await b.request((ctx) => auth.requireRole(ctx, 'admin'));
			return true;
		} catch (e) {
			assert.ok(e instanceof ApiError && e.name === AuthErrors.NotAuthorized, `403, got ${String(e)}`);
			return false;
		}
	}

	test('add-to-group by verified email makes the first admin; remove-from-group undoes it', async () => {
		const auth = makeAuth();
		await register(auth, 'owner', 'you@example.com');
		const before = JSON.parse(readFileSync(join('.bb-data', auth.fullId, 'state.json'), 'utf8'));
		assert.strictEqual(await isAdmin('owner'), false);

		const added = await cli(['add-to-group', 'you@example.com', 'admin']);
		assert.strictEqual(added.code, 0, added.err);
		assert.match(added.out, new RegExp(`local pool ${auth.fullId}`));
		assert.match(added.out, /added 'you@example.com' \(username owner\) to 'admin'/);
		assert.strictEqual(await isAdmin('owner'), true);

		// Every other key of the file is kept: users, codes, the session secret.
		const after = JSON.parse(readFileSync(join('.bb-data', auth.fullId, 'state.json'), 'utf8'));
		assert.strictEqual(after.sessionSecret, before.sessionSecret);
		assert.deepStrictEqual(after.users, before.users);

		const listed = await cli(['list-groups', 'owner']);
		assert.match(listed.out, /'owner' \(you@example.com\) is in: admin/);
		assert.match((await cli(['list-groups'])).out, /Groups: admin, editors/);

		// Idempotent.
		assert.strictEqual((await cli(['add-to-group', 'owner', 'admin'])).code, 0);
		const removed = await cli(['remove-from-group', 'owner', 'admin']);
		assert.strictEqual(removed.code, 0, removed.err);
		assert.strictEqual(await isAdmin('owner'), false);
	});

	test('refuses a group the block does not declare, and changes nothing', async () => {
		const auth = makeAuth();
		await register(auth, 'owner', 'you@example.com');
		const file = join('.bb-data', auth.fullId, 'state.json');
		const before = readFileSync(file, 'utf8');
		const r = await cli(['add-to-group', 'owner', 'admins']);
		assert.strictEqual(r.code, 1);
		assert.match(r.err, /'admins' is not a group of local pool .*It declares: admin, editors\..*users\.groups/);
		assert.strictEqual(readFileSync(file, 'utf8'), before);
	});

	test('refuses a user the pool does not have', async () => {
		const auth = makeAuth();
		await register(auth, 'owner', 'you@example.com');
		const r = await cli(['add-to-group', 'nobody@example.com', 'admin']);
		assert.strictEqual(r.code, 1);
		assert.match(r.err, /No user 'nobody@example.com' in the local pool/);
	});

	test('refuses an email the pool has not verified: a user can set their own', async () => {
		const auth = makeAuth();
		await register(auth, 'mallory', 'mallory@example.com');
		const b = new Browser();
		await b.request((ctx) => auth.signIn('mallory', PASSWORD, ctx));
		await b.request((ctx) => auth.updateUserAttributes(ctx, { email: 'you@example.com' }));

		const r = await cli(['add-to-group', 'you@example.com', 'admin']);
		assert.strictEqual(r.code, 1);
		assert.match(r.err, /'you@example.com' is the email of user 'mallory', but the pool has not verified it/);
		assert.strictEqual(await isAdmin('mallory'), false);
		// By username, the operator names the user outright.
		assert.strictEqual((await cli(['add-to-group', 'mallory', 'admin'])).code, 0);
	});

	test('with two Auth blocks, --block picks one', async () => {
		const auth = makeAuth();
		const other = makeAuth('staff-auth');
		await register(auth, 'owner', 'you@example.com');
		await register(other, 'owner', 'you@example.com');
		const r = await cli(['add-to-group', 'owner', 'admin']);
		assert.strictEqual(r.code, 1);
		assert.match(r.err, /2 local Auth blocks .*pass --block <id>/);
		const picked = await cli(['add-to-group', 'owner', 'admin', '--block', 'staff-auth']);
		assert.strictEqual(picked.code, 0, picked.err);
		assert.match(picked.out, new RegExp(`local pool ${other.fullId}`));
		assert.strictEqual(await isAdmin('owner'), false, 'the other block is unchanged');
		assert.strictEqual((await cli(['add-to-group', 'owner', 'admin', `--block=${auth.fullId}`])).code, 0);
		assert.strictEqual(await isAdmin('owner'), true);
	});

	test('refuses while the dev server runs: it would write its copy of the pool back', async () => {
		const auth = makeAuth();
		await register(auth, 'owner', 'you@example.com');
		mkdirSync('.blocks-sandbox', { recursive: true });
		const pidfile = join('.blocks-sandbox', 'dev-server.3000.pid');
		writeFileSync(pidfile, JSON.stringify({ pid: 4242, ppid: 4241, port: 3000 }));
		try {
			const r = await cli(['add-to-group', 'owner', 'admin'], { isPidAlive: (pid) => pid === 4242 });
			assert.strictEqual(r.code, 1);
			assert.match(r.err, /dev server is running \(pid 4242\).*npm run dev:stop/);
			assert.strictEqual(await isAdmin('owner'), false);
			// Reading is fine.
			assert.strictEqual((await cli(['list-groups'], { isPidAlive: () => true })).code, 0);
		} finally {
			rmSync('.blocks-sandbox', { recursive: true, force: true });
		}
	});

	test('no local pool: says where it looked and how to reach a deployed one', async () => {
		const empty = mkdtempSync(join(tmpdir(), 'bb-auth-users-'));
		try {
			const r = await cli(['add-to-group', 'owner', 'admin'], { cwd: empty });
			assert.strictEqual(r.code, 1);
			assert.match(r.err, /No local user pool under .*--stage or --stack/);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	test('a username that looks like an email cannot stand in for the user who holds that email verified', async () => {
		// `signInWith: ['username']`: any string is a username, `boss@corp.com` included.
		const pool = new Auth(root, 'auth', {
			users: { signInWith: ['username'], groups: ['admin'] },
			admin: { actions: ['lifecycle'] },
		});
		await pool.admin.createUser('owner', { attributes: { email: 'boss@corp.com', email_verified: 'true' } });
		await pool.signUp('boss@corp.com', PASSWORD, { attributes: { email: 'eve@example.com' } });
		const file = join('.bb-data', pool.fullId, 'state.json');
		const admins = () => JSON.parse(readFileSync(file, 'utf8')).groups.admin;

		const r = await cli(['add-to-group', 'boss@corp.com', 'admin']);
		assert.strictEqual(r.code, 1);
		assert.match(
			r.err,
			/'boss@corp.com' is ambiguous: it is the username of user 'boss@corp.com' and the verified email of user 'owner'.*--username boss@corp.com, or --email boss@corp.com/,
		);
		assert.deepStrictEqual(admins(), []);

		const byEmail = await cli(['add-to-group', '--email', 'boss@corp.com', 'admin']);
		assert.strictEqual(byEmail.code, 0, byEmail.err);
		assert.deepStrictEqual(admins(), ['owner']);
		const byUsername = await cli(['add-to-group', '--username=boss@corp.com', 'admin']);
		assert.strictEqual(byUsername.code, 0, byUsername.err);
		assert.deepStrictEqual(admins(), ['owner', 'boss@corp.com']);
		assert.match((await cli(['list-groups', '--email', 'boss@corp.com'])).out, /\(username owner\) is in: admin/);
		// --email takes a verified email only; --username a username only.
		assert.match((await cli(['list-groups', '--email', 'eve@example.com'])).err, /has not verified it/);
		assert.match((await cli(['list-groups', '--username', 'nobody'])).err, /No user with the username 'nobody'/);
	});

	test('usage errors exit 2', async () => {
		for (const argv of [
			[],
			['promote', 'owner'],
			['add-to-group', 'owner'],
			['add-to-group', 'owner', 'admin', '--profile', 'p'],
			['add-to-group', 'owner', 'admin', '--stage', 'prod', '--stack', 's'],
			['add-to-group', 'owner', 'admin', '--force'],
			['add-to-group', 'owner', 'admin', '--username', 'owner'],
			['add-to-group', '--username', 'a', '--email', 'b@example.com', 'admin'],
			['list-groups', 'owner', '--email', 'b@example.com'],
		]) {
			const r = await cli(argv);
			assert.strictEqual(r.code, 2, `${argv.join(' ')}: ${r.err}`);
			assert.match(r.err, /Usage: npx @aws-blocks\/bb-auth users/);
		}
		assert.strictEqual((await cli(['--help'])).code, 0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Deployed pool (SDK faked)
// ─────────────────────────────────────────────────────────────────────────────

const POOL_ID = 'us-east-1_ExamplePool';
/** The AWS documentation's example account id. */
const ACCOUNT = '123456789012';

/** The input of the first `name` command sent. */
function input(sent: readonly Sent[], name: string): Record<string, unknown> | undefined {
	return sent.find((s) => s.name === name)?.input;
}
const UUID = '0f1e2d3c-aaaa-bbbb-cccc-000000000001';

/** A stack template with two `Auth` blocks: `auth` (groups admin, editors) and `oidc-auth` (group staff). */
function template(stackName: string) {
	return {
		Resources: {
			appauthpoolA1B2C3D4: {
				Type: 'AWS::Cognito::UserPool',
				Properties: { UserPoolName: `${stackName}-my-app-auth` },
			},
			appauthgroupadminE5F6: {
				Type: 'AWS::Cognito::UserPoolGroup',
				Properties: { UserPoolId: { Ref: 'appauthpoolA1B2C3D4' }, GroupName: 'admin' },
			},
			appauthgroupeditors0000: {
				Type: 'AWS::Cognito::UserPoolGroup',
				Properties: { UserPoolId: { Ref: 'appauthpoolA1B2C3D4' }, GroupName: 'editors' },
			},
			appstaffauthpool9999: {
				Type: 'AWS::Cognito::UserPool',
				Properties: { UserPoolName: `${stackName}-my-app-oidc-auth` },
			},
			appstaffgroupstaff9999: {
				Type: 'AWS::Cognito::UserPoolGroup',
				Properties: { UserPoolId: { Ref: 'appstaffauthpool9999' }, GroupName: 'staff' },
			},
		},
	};
}

interface Sent {
	name: string;
	input: Record<string, unknown>;
}

type Responder = (input: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;

function serviceError(name: string, message = name): Error {
	const e = new Error(message);
	e.name = name;
	return e;
}

/** SDK clients whose every command is answered by `responders` (an unexpected one throws). */
function fakeClients(responders: Record<string, Responder>) {
	const sent: Sent[] = [];
	const configs: { region?: string; profile?: string }[] = [];
	const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example' };
	// Stands in for the client's `send`: records the command (name + input) and answers it.
	const send = async (command: { constructor: { name: string }; input: object }) => {
		const name = command.constructor.name;
		const input: Record<string, unknown> = JSON.parse(JSON.stringify(command.input));
		sent.push({ name, input });
		const fn = responders[name] ?? (name === 'GetCallerIdentityCommand' ? () => ({ Account: ACCOUNT }) : undefined);
		if (!fn) throw new Error(`unexpected command ${name}`);
		return { $metadata: { httpStatusCode: 200 }, ...(await fn(input)) };
	};
	const clients = (config: { region?: string; profile?: string }): DeployedClients => {
		configs.push(config);
		const cognito = new CognitoIdentityProviderClient({ region: 'us-east-1', credentials });
		const cloudFormation = new CloudFormationClient({ region: 'us-east-1', credentials });
		Object.defineProperty(cognito, 'send', { value: send });
		const sts = new STSClient({ region: 'us-east-1', credentials });
		Object.defineProperty(cloudFormation, 'send', { value: send });
		Object.defineProperty(sts, 'send', { value: send });
		return { cognito, cloudFormation, sts };
	};
	return { clients, sent, configs };
}

/** Responders for a stack with the template above, whose `auth` pool has `users`. */
function stackResponders(users: Record<string, Record<string, string>>): Record<string, Responder> {
	return {
		GetTemplateCommand: (input) => ({ TemplateBody: JSON.stringify(template(String(input.StackName))) }),
		DescribeStackResourceCommand: (input) => {
			assert.strictEqual(input.LogicalResourceId, 'appauthpoolA1B2C3D4');
			return { StackResourceDetail: { PhysicalResourceId: POOL_ID } };
		},
		AdminGetUserCommand: (input) => {
			assert.strictEqual(input.UserPoolId, POOL_ID);
			const login = String(input.Username);
			// Cognito resolves the username, or (on an email sign-in pool) the email.
			const found = Object.entries(users).find(([u, a]) => u === login || a.email === login);
			if (!found) throw serviceError('UserNotFoundException', 'User does not exist.');
			return {
				Username: found[0],
				UserAttributes: Object.entries(found[1]).map(([Name, Value]) => ({ Name, Value })),
			};
		},
		ListUsersCommand: (input) => {
			assert.strictEqual(input.UserPoolId, POOL_ID);
			const m = /^(email|phone_number) = "(.*)"$/.exec(String(input.Filter));
			assert.ok(m, `an escaped equality filter, got ${String(input.Filter)}`);
			const [, attribute, value] = m;
			return {
				Users: Object.entries(users)
					.filter(([, a]) => a[attribute] === value)
					.map(([Username, a]) => ({
						Username,
						Attributes: Object.entries(a).map(([Name, Value]) => ({ Name, Value })),
					})),
			};
		},
		AdminAddUserToGroupCommand: () => ({}),
		AdminRemoveUserFromGroupCommand: () => ({}),
		AdminListGroupsForUserCommand: () => ({ Groups: [{ GroupName: 'admin' }] }),
	};
}

describe('users CLI: deployed pool', () => {
	let project: string;
	beforeEach(() => {
		project = mkdtempSync(join(tmpdir(), 'bb-auth-users-deployed-'));
		mkdirSync(join(project, '.blocks'));
		writeFileSync(join(project, '.blocks', 'config.json'), JSON.stringify({ stackId: 'my-app' }));
	});
	afterEach(() => rmSync(project, { recursive: true, force: true }));

	const owner = { [UUID]: { sub: UUID, email: 'you@example.com', email_verified: 'true' } };

	test('--stage prod resolves the stack and pool; without --yes it checks everything and changes nothing', async () => {
		const fake = fakeClients(stackResponders(owner));
		const r = await cli(['add-to-group', 'you@example.com', 'admin', '--stage', 'prod', '--block', 'my-app-auth'], {
			cwd: project,
			clients: fake.clients,
		});
		assert.strictEqual(r.code, 1);
		assert.match(
			r.err,
			/Refusing to add 'you@example.com' \(username .*\) to 'admin' in user pool my-app-prod-my-app-auth \(us-east-1_ExamplePool\) in stack my-app-prod, account 123456789012, region us-east-1 without confirmation\. Re-run with --yes/,
		);
		assert.deepStrictEqual(
			fake.sent.map((s) => s.name),
			['GetCallerIdentityCommand', 'GetTemplateCommand', 'DescribeStackResourceCommand', 'AdminGetUserCommand'],
		);
		assert.deepStrictEqual(input(fake.sent, 'GetTemplateCommand'), { StackName: 'my-app-prod' });
	});

	test('--yes adds the resolved username (never the email again) to the group', async () => {
		const fake = fakeClients(stackResponders(owner));
		const r = await cli(
			[
				'add-to-group',
				'you@example.com',
				'admin',
				'--stage',
				'prod',
				'--block',
				'my-app-auth',
				'--yes',
				'--profile',
				'ops',
				'--region',
				'eu-west-1',
			],
			{ cwd: project, clients: fake.clients },
		);
		assert.strictEqual(r.code, 0, r.err);
		assert.deepStrictEqual(fake.configs, [{ region: 'eu-west-1', profile: 'ops' }]);
		const add = fake.sent.find((s) => s.name === 'AdminAddUserToGroupCommand');
		assert.deepStrictEqual(add?.input, { UserPoolId: POOL_ID, Username: UUID, GroupName: 'admin' });
		assert.match(r.out, /Done: added 'you@example.com' \(username .*\) to 'admin'/);
	});

	test('remove-from-group and list-groups', async () => {
		const fake = fakeClients(stackResponders(owner));
		const deps = { cwd: project, clients: fake.clients };
		const removed = await cli(
			['remove-from-group', UUID, 'admin', '--stack', 'custom-stack', '--block', 'my-app-auth', '-y'],
			deps,
		);
		assert.strictEqual(removed.code, 0, removed.err);
		assert.deepStrictEqual(fake.sent.find((s) => s.name === 'AdminRemoveUserFromGroupCommand')?.input, {
			UserPoolId: POOL_ID,
			Username: UUID,
			GroupName: 'admin',
		});
		assert.deepStrictEqual(input(fake.sent, 'GetTemplateCommand'), { StackName: 'custom-stack' });
		const listed = await cli(['list-groups', UUID, '--stack', 'custom-stack', '--block', 'my-app-auth'], deps);
		assert.strictEqual(listed.code, 0, listed.err);
		assert.match(listed.out, /is in: admin/);
		const groups = await cli(['list-groups', '--stack', 'custom-stack', '--block', 'my-app-auth'], deps);
		assert.match(groups.out, /Groups: admin, editors/);
	});

	test("refuses a group the block does not declare — including another block's", async () => {
		const fake = fakeClients(stackResponders(owner));
		const r = await cli(['add-to-group', UUID, 'staff', '--stage', 'prod', '--block', 'my-app-auth', '--yes'], {
			cwd: project,
			clients: fake.clients,
		});
		assert.strictEqual(r.code, 1);
		assert.match(
			r.err,
			/'staff' is not a group of user pool my-app-prod-my-app-auth .*It declares: admin, editors\..*and deploy first/,
		);
		assert.ok(!fake.sent.some((s) => s.name.startsWith('Admin')), 'no Cognito call');
	});

	test('refuses a user the pool does not have', async () => {
		const fake = fakeClients(stackResponders(owner));
		const r = await cli(
			['add-to-group', 'nobody@example.com', 'admin', '--stage', 'prod', '--block', 'my-app-auth', '--yes'],
			{
				cwd: project,
				clients: fake.clients,
			},
		);
		assert.strictEqual(r.code, 1);
		assert.match(r.err, /No user 'nobody@example.com' in my-app-prod-my-app-auth/);
		assert.ok(!fake.sent.some((s) => s.name === 'AdminAddUserToGroupCommand'));
	});

	test('refuses an unverified email even with --yes', async () => {
		const unverified = { [UUID]: { sub: UUID, email: 'you@example.com', email_verified: 'false' } };
		const fake = fakeClients(stackResponders(unverified));
		const r = await cli(
			['add-to-group', 'you@example.com', 'admin', '--stage', 'prod', '--block', 'my-app-auth', '--yes'],
			{
				cwd: project,
				clients: fake.clients,
			},
		);
		assert.strictEqual(r.code, 1);
		assert.match(r.err, /the pool has not verified it/);
		assert.ok(!fake.sent.some((s) => s.name === 'AdminAddUserToGroupCommand'));
	});

	test('two pools in the stack: --block picks one; a stage name it does not know is refused', async () => {
		const fake = fakeClients(stackResponders(owner));
		const deps = { cwd: project, clients: fake.clients };
		const r = await cli(['list-groups', '--stage', 'prod'], deps);
		assert.strictEqual(r.code, 1);
		assert.match(r.err, /has 2 user pools \(my-app-prod-my-app-auth, my-app-prod-my-app-oidc-auth\): pass --block/);
		// `auth` is the id of one and the end of the other's: the full id (or more of it) settles it.
		const both = await cli(['list-groups', '--stage', 'prod', '--block', 'auth'], deps);
		assert.strictEqual(both.code, 1);
		assert.match(
			both.err,
			/--block 'auth' matches my-app-prod-my-app-auth, my-app-prod-my-app-oidc-auth: pass the full id/,
		);
		const ambiguous = await cli(['list-groups', '--stage', 'prod', '--block', 'nope'], deps);
		assert.match(ambiguous.err, /No Auth block in stack 'my-app-prod' matches --block 'nope'/);
		const stage = await cli(['list-groups', '--stage', 'staging'], deps);
		assert.strictEqual(stage.code, 1);
		assert.match(stage.err, /Unknown stage 'staging'.*--stack <name>/);
	});

	test('--stage sandbox is this checkout’s sandbox stack, and needs one', async () => {
		const fake = fakeClients(stackResponders(owner));
		const deps = { cwd: project, clients: fake.clients };
		const missing = await cli(['list-groups', '--stage', 'sandbox', '--block', 'my-app-auth'], deps);
		assert.strictEqual(missing.code, 1);
		assert.match(missing.err, /No sandbox for this checkout/);
		mkdirSync(join(project, '.blocks-sandbox'));
		writeFileSync(join(project, '.blocks-sandbox', 'sandbox-id.txt'), 'dev-abc123');
		const ok = await cli(['list-groups', '--stage', 'sandbox', '--block', 'my-app-auth'], deps);
		assert.strictEqual(ok.code, 0, ok.err);
		assert.deepStrictEqual(input(fake.sent, 'GetTemplateCommand'), { StackName: 'my-app-dev-abc123' });
	});

	test('a username that looks like an email cannot stand in for the user who holds that email verified', async () => {
		// The username `boss@corp.com` (listed first, so AdminGetUser matches it by username) and the
		// user whose verified email it is.
		const users = {
			'boss@corp.com': { sub: 'eve-sub', email: 'eve@example.com', email_verified: 'true' },
			[UUID]: { sub: UUID, email: 'boss@corp.com', email_verified: 'true' },
		};
		const run = async (argv: string[]) => {
			const fake = fakeClients(stackResponders(users));
			const r = await cli([...argv, '--stage', 'prod', '--block', 'my-app-auth', '--yes'], {
				cwd: project,
				clients: fake.clients,
			});
			return { ...r, sent: fake.sent };
		};
		const refused = await run(['add-to-group', 'boss@corp.com', 'admin']);
		assert.strictEqual(refused.code, 1);
		assert.match(
			refused.err,
			/'boss@corp.com' is ambiguous: .*username of user 'boss@corp.com' and the verified email of user '0f1e2d3c/,
		);
		assert.deepStrictEqual(input(refused.sent, 'ListUsersCommand'), {
			UserPoolId: POOL_ID,
			Filter: 'email = "boss@corp.com"',
		});
		assert.ok(!refused.sent.some((s) => s.name === 'AdminAddUserToGroupCommand'));

		const byEmail = await run(['add-to-group', '--email', 'boss@corp.com', 'admin']);
		assert.strictEqual(byEmail.code, 0, byEmail.err);
		assert.deepStrictEqual(input(byEmail.sent, 'AdminAddUserToGroupCommand'), {
			UserPoolId: POOL_ID,
			Username: UUID,
			GroupName: 'admin',
		});
		assert.ok(!byEmail.sent.some((s) => s.name === 'AdminGetUserCommand'), '--email never resolves by username');

		const byUsername = await run(['add-to-group', '--username', 'boss@corp.com', 'admin']);
		assert.strictEqual(byUsername.code, 0, byUsername.err);
		assert.deepStrictEqual(input(byUsername.sent, 'AdminAddUserToGroupCommand'), {
			UserPoolId: POOL_ID,
			Username: 'boss@corp.com',
			GroupName: 'admin',
		});

		// --username refuses what Cognito resolved through an email instead.
		const notAUsername = await run(['add-to-group', '--username', 'you@example.com', 'admin']);
		assert.strictEqual(notAUsername.code, 1);
		const fake = fakeClients(stackResponders(owner));
		const viaAlias = await cli(
			[
				'add-to-group',
				'--username',
				'you@example.com',
				'admin',
				'--stage',
				'prod',
				'--block',
				'my-app-auth',
				'--yes',
			],
			{ cwd: project, clients: fake.clients },
		);
		assert.match(viaAlias.err, /No user with the username 'you@example.com'/);
		// A value the filter cannot quote safely is refused before any call.
		const quoted = await run(['add-to-group', '--email', 'a"@example.com', 'admin']);
		assert.match(quoted.err, /cannot be looked up: .*double quote/);
	});

	test('the pool line names the account and Region the credentials point at', async () => {
		const fake = fakeClients(stackResponders(owner));
		const r = await cli(['list-groups', '--stage', 'prod', '--block', 'my-app-auth'], {
			cwd: project,
			clients: fake.clients,
		});
		assert.strictEqual(r.code, 0, r.err);
		assert.match(
			r.out,
			/Pool: user pool my-app-prod-my-app-auth \(us-east-1_ExamplePool\) in stack my-app-prod, account 123456789012, region us-east-1/,
		);
		assert.strictEqual(fake.sent[0].name, 'GetCallerIdentityCommand', 'before reading the stack');
		const noCredentials = fakeClients({
			GetCallerIdentityCommand: () => {
				throw serviceError('ExpiredTokenException', 'The security token included in the request is expired');
			},
		});
		const e = await cli(['list-groups', '--stage', 'prod'], { cwd: project, clients: noCredentials.clients });
		assert.strictEqual(e.code, 1);
		assert.match(e.err, /GetCallerIdentity\) failed — ExpiredTokenException/);
	});

	test('a stack without a pool this app owns, and an SDK failure, are one-line messages', async () => {
		const noPool = fakeClients({ GetTemplateCommand: () => ({ TemplateBody: JSON.stringify({ Resources: {} }) }) });
		const r = await cli(['list-groups', '--stack', 's'], { cwd: project, clients: noPool.clients });
		assert.strictEqual(r.code, 1);
		assert.match(r.err, /has no user pool created by an Auth block.*Auth\.fromExisting/);
		const failing = fakeClients({
			GetTemplateCommand: () => {
				throw serviceError('ValidationError', 'Stack with id s does not exist');
			},
		});
		const f = await cli(['list-groups', '--stack', 's'], { cwd: project, clients: failing.clients });
		assert.strictEqual(f.code, 1);
		assert.match(f.err, /Reading stack 's' failed — ValidationError: Stack with id s does not exist/);
	});
});

describe('users CLI: the bb-auth bin', () => {
	test('`bb-auth users …` reaches the users CLI; other commands still reach migrate', async () => {
		const { spawnSync } = await import('node:child_process');
		const bin = join(PACKAGE_DIR, 'dist', 'bin.js');
		const users = spawnSync(process.execPath, [bin, 'users', '--help'], { encoding: 'utf8' });
		assert.strictEqual(users.status, 0, users.stderr);
		assert.match(users.stdout, /Usage: npx @aws-blocks\/bb-auth users <command>/);
		const migrate = spawnSync(process.execPath, [bin, 'migrate', '--help'], { encoding: 'utf8' });
		assert.strictEqual(migrate.status, 0, migrate.stderr);
		assert.match(migrate.stdout, /Usage: npx @aws-blocks\/bb-auth migrate/);
		const unknown = spawnSync(process.execPath, [bin, 'promote'], { encoding: 'utf8' });
		assert.strictEqual(unknown.status, 2);
	});
});

describe('users CLI: documented commands', () => {
	test('every `npx @aws-blocks/bb-auth users …` line in the README and the usage text parses', async () => {
		const { USERS_USAGE } = await import('./users-cli/cli.js');
		const readme = readFileSync(join(PACKAGE_DIR, 'README.md'), 'utf8');
		const lines = [...`${readme}\n${USERS_USAGE}`.matchAll(/npx @aws-blocks\/bb-auth users ([^`\n]*)/g)].map((m) =>
			m[1].trim(),
		);
		assert.ok(lines.length >= 4, `found ${lines.length}`);
		for (const line of lines) {
			if (line === '--help' || line.startsWith('<command>')) continue;
			assert.doesNotThrow(() => parseUsersArgs(line.split(/\s+/)), line);
		}
	});
});
