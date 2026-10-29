// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `npx @aws-blocks/bb-auth users <command>` — put users in the groups an
 * `Auth` block declares (`users.groups`), locally or on a deployed stack.
 * The supported way to make the first admin.
 *
 * - Locally (no `--stage` / `--stack`) it edits the local pool,
 *   `.bb-data/<fullId>/state.json`, and refuses while the dev server runs (it
 *   would write its in-memory copy back over the change).
 * - With `--stage sandbox|prod` (or `--stack <name>`) it calls Cognito on the
 *   pool the block owns in that stack, with the caller's AWS credentials
 *   (`--profile`, `--region`, or the SDK's usual resolution). Every write to a
 *   deployed pool needs `--yes`: a stage name cannot tell production apart
 *   reliably, so, as with `secret remove --force`, the confirmation is never
 *   implied. Without it the command checks everything, prints what it would
 *   do, and changes nothing.
 *
 * It refuses a group the block does not declare and a user the pool does not
 * have. `<user>` is the username, or the user's **verified** email / phone
 * number: an unverified one is refused, because a signed-in user can set
 * their own email to anyone's.
 *
 * @internal
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DeployedClients } from './deployed.js';
import { localTarget, runningDevServers, selectLocalPool } from './local.js';
import { type PoolTarget, type ResolvedUser, type UserSelector, UsersCliError } from './target.js';

export const USERS_USAGE = `Usage: npx @aws-blocks/bb-auth users <command> [options]

Manage the group membership of an Auth block's users (users.groups).

Commands:
  add-to-group <user> <group>        Add a user to a group (e.g. the first admin).
  remove-from-group <user> <group>   Remove a user from a group.
  list-groups [<user>]               The block's groups, or the groups <user> is in.

  <user> is the username, or the user's verified email / phone number. A value
  that is one user's username and another user's verified email / phone number
  is refused as ambiguous: name the user with --username or --email instead.

Options:
  --username <name>  The user with exactly this username (instead of <user>).
  --email <addr>     The user whose verified email this is (instead of <user>).
  --block <id>       The Auth block (its id or full id), when the app has more than one.
  --stage <name>     A deployed stage: sandbox or prod. Default: the local pool in .bb-data/.
  --stack <name>     A deployed CloudFormation stack, by name (instead of --stage).
  --profile <name>   AWS profile for a deployed stage (default: the SDK's, e.g. AWS_PROFILE).
  --region <name>    AWS Region for a deployed stage (default: the SDK's, e.g. AWS_REGION).
  --yes, -y          Confirm a change to a deployed pool. Without it, nothing is changed.
  --help, -h         Show this help.

The group must be one the block declares (users.groups). On a deployed stage
that is read from the stack. Locally it is a group the local pool holds: the
pool adds each declared group when the backend loads and never removes one, so
a group since dropped from users.groups is still accepted until .bb-data/ is
reset. The pool line shows the AWS account and Region of a deployed pool.

Examples:
  npx @aws-blocks/bb-auth users add-to-group you@example.com admin
  npx @aws-blocks/bb-auth users add-to-group you@example.com admin --stage prod --yes`;

type Command = 'add-to-group' | 'remove-from-group' | 'list-groups';
const COMMANDS: readonly Command[] = ['add-to-group', 'remove-from-group', 'list-groups'];

export interface UsersArgs {
	command: Command;
	user?: UserSelector;
	group?: string;
	block?: string;
	stage?: string;
	stack?: string;
	profile?: string;
	region?: string;
	yes: boolean;
}

/** Seams for tests: where to run, where output goes, the SDK clients and the pid check. */
export interface UsersCliDeps {
	cwd?: string;
	log?: (line: string) => void;
	error?: (line: string) => void;
	/** Build the SDK clients for a deployed stage. Default: real clients for `--region` / `--profile`. */
	clients?: (config: { region?: string; profile?: string }) => DeployedClients;
	isPidAlive?: (pid: number) => boolean;
}

class UsageError extends Error {}

const VALUE_FLAGS = ['username', 'email', 'block', 'stage', 'stack', 'profile', 'region'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

function isValueFlag(name: string): name is ValueFlag {
	return VALUE_FLAGS.some((f) => f === name);
}

function isCommand(name: string | undefined): name is Command {
	return COMMANDS.some((c) => c === name);
}

/** Parse `users …` arguments (after `users`). Throws {@link UsageError}. */
export function parseUsersArgs(argv: readonly string[]): UsersArgs {
	const positional: string[] = [];
	const values: Partial<Record<ValueFlag, string>> = {};
	let yes = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--yes' || arg === '-y') {
			yes = true;
			continue;
		}
		if (!arg.startsWith('--')) {
			positional.push(arg);
			continue;
		}
		const eq = arg.indexOf('=');
		const name = arg.slice(2, eq === -1 ? undefined : eq);
		if (!isValueFlag(name)) throw new UsageError(`Unknown option: ${arg}`);
		const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
		if (value === undefined || value === '' || (eq === -1 && value.startsWith('-'))) {
			throw new UsageError(`--${name} needs a value.`);
		}
		values[name] = value;
	}
	const [command, ...rest] = positional;
	if (!isCommand(command)) {
		throw new UsageError(command === undefined ? 'Missing command.' : `Unknown command: users ${command}`);
	}
	if (values.username !== undefined && values.email !== undefined) {
		throw new UsageError('Pass --username or --email, not both.');
	}
	const named: UserSelector | undefined =
		values.username !== undefined
			? { by: 'username', value: values.username }
			: values.email !== undefined
				? { by: 'email', value: values.email }
				: undefined;
	// With --username / --email the user is not positional.
	const userArgs = named ? 0 : 1;
	const arity = command === 'list-groups' ? [0, userArgs] : [1 + userArgs, 1 + userArgs];
	if (rest.length < arity[0] || rest.length > arity[1]) {
		throw new UsageError(
			command === 'list-groups'
				? 'Usage: users list-groups [<user> | --username <name> | --email <addr>]'
				: `Usage: users ${command} (<user> | --username <name> | --email <addr>) <group>`,
		);
	}
	if (values.stage !== undefined && values.stack !== undefined)
		throw new UsageError('Pass --stage or --stack, not both.');
	const deployed = values.stage !== undefined || values.stack !== undefined;
	for (const f of ['profile', 'region'] as const) {
		if (values[f] !== undefined && !deployed) {
			throw new UsageError(`--${f} applies to a deployed pool: pass --stage or --stack too.`);
		}
	}
	const user: UserSelector | undefined = named ?? (rest[0] === undefined ? undefined : { by: 'any', value: rest[0] });
	const group = command === 'list-groups' ? undefined : rest[userArgs];
	const { block, stage, stack, profile, region } = values;
	return { command, user, group, block, stage, stack, profile, region, yes };
}

/**
 * The CloudFormation stack a `--stage` names, as the app's CDK entry names it
 * (`getStackName`): `prod` / `production` → `<stackId>-prod`; `sandbox` →
 * this machine's sandbox, `<stackId>-<sandboxId>`.
 */
export async function stackNameForStage(stage: string, cwd: string): Promise<string> {
	const { getStackName } = await import('@aws-blocks/core/scripts');
	const projectRoot = resolve(cwd);
	if (stage === 'prod' || stage === 'production') {
		try {
			return getStackName({ sandbox: false, projectRoot });
		} catch (e) {
			throw new UsersCliError(e instanceof Error ? e.message : String(e));
		}
	}
	if (stage === 'sandbox') {
		// getStackName would create a sandbox id: there is no sandbox to manage without one.
		if (!existsSync(join(projectRoot, '.blocks-sandbox', 'sandbox-id.txt'))) {
			throw new UsersCliError(
				'No sandbox for this checkout (.blocks-sandbox/sandbox-id.txt is missing): deploy one with `npm run sandbox`, or pass --stack <name>.',
			);
		}
		try {
			return getStackName({ sandbox: true, projectRoot });
		} catch (e) {
			throw new UsersCliError(e instanceof Error ? e.message : String(e));
		}
	}
	throw new UsersCliError(
		`Unknown stage '${stage}': use --stage sandbox or --stage prod, or name the stack with --stack <name>.`,
	);
}

function describeUser(user: ResolvedUser, login: string): string {
	const contact = user.email ?? user.phoneNumber;
	if (user.username === login) return contact ? `'${user.username}' (${contact})` : `'${user.username}'`;
	return `'${login}' (username ${user.username})`;
}

async function target(args: UsersArgs, deps: UsersCliDeps, cwd: string): Promise<PoolTarget> {
	if (args.stage === undefined && args.stack === undefined) {
		return localTarget(selectLocalPool(cwd, args.block), cwd);
	}
	const stackName = args.stack ?? (await stackNameForStage(args.stage ?? '', cwd));
	const { deployedTarget, defaultClients } = await import('./deployed.js');
	const clients = (deps.clients ?? defaultClients)({ region: args.region, profile: args.profile });
	return deployedTarget(stackName, args.block, clients);
}

function requireDeclaredGroup(t: PoolTarget, group: string): void {
	if (t.groups.includes(group)) return;
	const declared = t.groups.length > 0 ? `It declares: ${t.groups.join(', ')}.` : 'It declares none.';
	throw new UsersCliError(
		`'${group}' is not a group of ${t.description}. ${declared} Add it to the block's \`users.groups\`` +
			(t.deployed ? ' and deploy first.' : ' and start the backend once (`npm run dev`) first.'),
	);
}

/** Run `users …` (argv after `users`). Returns the exit code: 0 done, 1 refused or failed, 2 usage. */
export async function runUsersCli(argv: readonly string[], deps: UsersCliDeps = {}): Promise<number> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const error = deps.error ?? ((line: string) => console.error(line));
	const cwd = deps.cwd ?? process.cwd();
	if (argv.includes('--help') || argv.includes('-h')) {
		log(USERS_USAGE);
		return 0;
	}
	let args: UsersArgs;
	try {
		args = parseUsersArgs(argv);
	} catch (e) {
		if (!(e instanceof UsageError)) throw e;
		error(`${e.message}\n\n${USERS_USAGE}`);
		return 2;
	}
	try {
		const writes = args.command !== 'list-groups';
		const local = args.stage === undefined && args.stack === undefined;
		if (writes && local) {
			const pids = runningDevServers(cwd, deps.isPidAlive);
			if (pids.length > 0) {
				throw new UsersCliError(
					`The dev server is running (pid ${pids.join(', ')}). It keeps the local pool in memory and would ` +
						'write it back over this change. Stop it (`npm run dev:stop`), run this again, then restart it.',
				);
			}
		}
		const t = await target(args, deps, cwd);
		log(`Pool: ${t.description}`);
		if (args.command === 'list-groups') {
			if (args.user === undefined) {
				log(t.groups.length > 0 ? `Groups: ${t.groups.join(', ')}` : 'Groups: none declared (users.groups)');
				return 0;
			}
			const user = await t.resolveUser(args.user);
			const groups = await t.groupsOf(user.username);
			log(`${describeUser(user, args.user.value)} is in: ${groups.length > 0 ? groups.join(', ') : 'no groups'}`);
			return 0;
		}
		const group = args.group ?? '';
		requireDeclaredGroup(t, group);
		const selector = args.user ?? { by: 'any', value: '' };
		const user = await t.resolveUser(selector);
		const who = describeUser(user, selector.value);
		const adding = args.command === 'add-to-group';
		const action = adding ? `add ${who} to '${group}'` : `remove ${who} from '${group}'`;
		if (t.deployed && !args.yes) {
			throw new UsersCliError(
				`Refusing to ${action} in ${t.description} without confirmation. Re-run with --yes to confirm.`,
			);
		}
		if (adding) await t.addToGroup(user.username, group);
		else await t.removeFromGroup(user.username, group);
		log(
			`Done: ${adding ? `added ${who} to` : `removed ${who} from`} '${group}'. ` +
				"`requireRole` sees it on the user's next request.",
		);
		return 0;
	} catch (e) {
		if (!(e instanceof UsersCliError)) throw e;
		error(e.message);
		return 1;
	}
}
