// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `bb-auth users …` against a deployed stack: the Cognito user pool an `Auth`
 * block in that stack owns, called with the caller's AWS credentials.
 *
 * The pool and its groups come from the stack's own template, so nothing is
 * guessed from names: the `AWS::Cognito::UserPool` resources (their
 * `UserPoolName` is the block's full id), the pool id CloudFormation recorded
 * for the chosen one, and the `AWS::Cognito::UserPoolGroup` resources that
 * reference it — exactly the deployed `users.groups`.
 *
 * @internal
 */

import { CloudFormationClient, DescribeStackResourceCommand, GetTemplateCommand } from '@aws-sdk/client-cloudformation';
import {
	AdminAddUserToGroupCommand,
	AdminGetUserCommand,
	type AdminGetUserCommandOutput,
	AdminListGroupsForUserCommand,
	AdminRemoveUserFromGroupCommand,
	type AttributeType,
	CognitoIdentityProviderClient,
	ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { toCognitoFilter } from '../admin-filter.js';
import { isRecord, selectBlocks } from '../local-pool-files.js';
import {
	contactAttributeOf,
	type PoolTarget,
	type ResolvedUser,
	UsersCliError,
	unverifiedMatch,
	usernameShadowsContact,
} from './target.js';

function attributeMap(attributes: readonly AttributeType[] | undefined): Record<string, string> {
	return Object.fromEntries((attributes ?? []).map((a) => [a.Name ?? '', a.Value ?? '']));
}

/** The SDK clients a deployed command uses. Tests pass clients whose `send` is faked. */
export interface DeployedClients {
	cognito: CognitoIdentityProviderClient;
	cloudFormation: CloudFormationClient;
	/** For the account the credentials belong to (`GetCallerIdentity`), printed before any change. */
	sts: STSClient;
}

/** Region and profile: `--region` / `--profile`, else the SDK's own resolution (`AWS_REGION`, `AWS_PROFILE`, …). */
export interface ClientConfig {
	region?: string;
	profile?: string;
}

export function defaultClients(config: ClientConfig): DeployedClients {
	const sdkConfig = {
		...(config.region ? { region: config.region } : {}),
		...(config.profile ? { profile: config.profile } : {}),
	};
	return {
		cognito: new CognitoIdentityProviderClient(sdkConfig),
		cloudFormation: new CloudFormationClient(sdkConfig),
		sts: new STSClient(sdkConfig),
	};
}

interface TemplatePool {
	logicalId: string;
	/** `UserPoolName`: the block's full id. */
	name: string;
	groups: string[];
}

/** The user pools the template creates, each with the groups that reference it. */
export function poolsInTemplate(template: unknown): TemplatePool[] {
	const resources = isRecord(template) && isRecord(template.Resources) ? template.Resources : {};
	const pools: TemplatePool[] = [];
	for (const [logicalId, r] of Object.entries(resources)) {
		if (!isRecord(r) || r.Type !== 'AWS::Cognito::UserPool') continue;
		const props = isRecord(r.Properties) ? r.Properties : {};
		pools.push({
			logicalId,
			name: typeof props.UserPoolName === 'string' ? props.UserPoolName : logicalId,
			groups: [],
		});
	}
	for (const r of Object.values(resources)) {
		if (!isRecord(r) || r.Type !== 'AWS::Cognito::UserPoolGroup' || !isRecord(r.Properties)) continue;
		const { UserPoolId, GroupName } = r.Properties;
		if (typeof GroupName !== 'string' || !isRecord(UserPoolId)) continue;
		const pool = pools.find((p) => p.logicalId === UserPoolId.Ref);
		pool?.groups.push(GroupName);
	}
	return pools.sort((a, b) => a.name.localeCompare(b.name));
}

function errorName(e: unknown): string | undefined {
	return e instanceof Error ? e.name : undefined;
}

/** Turn an SDK failure into a one-line message (credentials, a missing stack, …). */
function sdkFailure(what: string, e: unknown): UsersCliError {
	const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
	return new UsersCliError(`${what} failed — ${detail}`);
}

/** Resolve the pool `--block` names in `stackName`, and build a {@link PoolTarget} over it. */
export async function deployedTarget(
	stackName: string,
	block: string | undefined,
	clients: DeployedClients,
): Promise<PoolTarget> {
	// Where the credentials point, shown with the pool: a `--stage prod` with the
	// wrong `--profile` is visible before `--yes`.
	let account: string | undefined;
	let region: string;
	try {
		account = (await clients.sts.send(new GetCallerIdentityCommand({}))).Account;
		region = await clients.cognito.config.region();
	} catch (e) {
		throw sdkFailure('Reading the AWS account of your credentials (GetCallerIdentity)', e);
	}
	let body: string | undefined;
	try {
		body = (await clients.cloudFormation.send(new GetTemplateCommand({ StackName: stackName }))).TemplateBody;
	} catch (e) {
		throw sdkFailure(`Reading stack '${stackName}'`, e);
	}
	let template: unknown;
	try {
		template = JSON.parse(body ?? '');
	} catch {
		throw new UsersCliError(`Stack '${stackName}' has a template this command cannot read (not JSON).`);
	}
	const pools = poolsInTemplate(template);
	if (pools.length === 0) {
		throw new UsersCliError(
			`Stack '${stackName}' has no user pool created by an Auth block. (A block with ` +
				'`userPool: Auth.fromExisting(…)` uses a pool managed elsewhere: manage its groups there.)',
		);
	}
	const matched = selectBlocks(
		pools.map((p) => ({ ...p, fullId: p.name })),
		block,
	);
	const list = pools.map((p) => p.name).join(', ');
	if (matched.length === 0)
		throw new UsersCliError(
			`No Auth block in stack '${stackName}' matches --block '${block}'. Its user pools: ${list}.`,
		);
	if (matched.length > 1) {
		throw new UsersCliError(
			block === undefined
				? `Stack '${stackName}' has ${pools.length} user pools (${list}): pass --block <id> to pick one.`
				: `--block '${block}' matches ${matched.map((p) => p.name).join(', ')}: pass the full id.`,
		);
	}
	const pool = matched[0];
	let userPoolId: string | undefined;
	try {
		const { StackResourceDetail } = await clients.cloudFormation.send(
			new DescribeStackResourceCommand({ StackName: stackName, LogicalResourceId: pool.logicalId }),
		);
		userPoolId = StackResourceDetail?.PhysicalResourceId;
	} catch (e) {
		throw sdkFailure(`Reading the user pool of stack '${stackName}'`, e);
	}
	if (!userPoolId) throw new UsersCliError(`Stack '${stackName}' has not created user pool '${pool.name}' yet.`);
	const id = userPoolId;
	const { cognito } = clients;

	/** The users whose `attribute` is `value` (`ListUsers`, with bb-auth's validated, quoted filter). */
	const listHolders = async (attribute: 'email' | 'phone_number', value: string) => {
		let Filter: string;
		try {
			Filter = toCognitoFilter({ attribute, match: 'equals', value });
		} catch (e) {
			throw new UsersCliError(`'${value}' cannot be looked up: ${e instanceof Error ? e.message : String(e)}`);
		}
		const holders: { user: Omit<ResolvedUser, 'matchedBy'>; verified: boolean }[] = [];
		let PaginationToken: string | undefined;
		try {
			do {
				const page = await cognito.send(new ListUsersCommand({ UserPoolId: id, Filter, PaginationToken }));
				for (const u of page.Users ?? []) {
					const a = attributeMap(u.Attributes);
					const held = a[attribute];
					const same = attribute === 'email' ? held?.toLowerCase() === value.toLowerCase() : held === value;
					if (!u.Username || !same) continue;
					holders.push({
						user: { username: u.Username, email: a.email, phoneNumber: a.phone_number },
						verified: a[`${attribute}_verified`] === 'true',
					});
				}
				PaginationToken = page.PaginationToken;
			} while (PaginationToken);
		} catch (e) {
			throw sdkFailure('ListUsers', e);
		}
		return holders;
	};

	return {
		deployed: true,
		description: `user pool ${pool.name} (${id}) in stack ${stackName}, account ${account ?? 'unknown'}, region ${region}`,
		groups: pool.groups,
		async resolveUser(selector) {
			const login = selector.value;
			if (selector.by === 'email') {
				const holders = await listHolders('email', login);
				const verified = holders.filter((h) => h.verified);
				if (verified.length === 1) return { ...verified[0].user, matchedBy: 'email' };
				if (verified.length > 1) {
					throw new UsersCliError(
						`'${login}' is the verified email of more than one user (${verified.map((h) => h.user.username).join(', ')}): pass --username.`,
					);
				}
				if (holders.length > 0) throw unverifiedMatch(login, 'email', holders[0].user.username);
				throw new UsersCliError(`No user has the email '${login}' in ${pool.name}.`);
			}
			let user: AdminGetUserCommandOutput;
			try {
				user = await cognito.send(new AdminGetUserCommand({ UserPoolId: id, Username: login }));
			} catch (e) {
				if (errorName(e) === 'UserNotFoundException') {
					throw new UsersCliError(
						selector.by === 'username'
							? `No user with the username '${login}' in ${pool.name}.`
							: `No user '${login}' in ${pool.name}.`,
					);
				}
				throw sdkFailure('AdminGetUser', e);
			}
			const username = user.Username ?? login;
			const attributes = attributeMap(user.UserAttributes);
			const resolved: ResolvedUser = {
				username,
				email: attributes.email,
				phoneNumber: attributes.phone_number,
				matchedBy: 'username',
			};
			const byUsername = username.toLowerCase() === login.toLowerCase();
			if (selector.by === 'username') {
				// Cognito resolved it by an email / phone number: no user has that username.
				if (!byUsername) throw new UsersCliError(`No user with the username '${login}' in ${pool.name}.`);
				return resolved;
			}
			if (byUsername) {
				// A username may have the form of an email / phone number (on a pool
				// that signs in with usernames anyone can register `boss@example.com`):
				// refuse when another user holds that value verified.
				const contact = contactAttributeOf(login);
				if (contact) {
					const other = (await listHolders(contact, login)).find(
						(h) => h.verified && h.user.username !== username,
					);
					if (other) throw usernameShadowsContact(login, contact, username, other.user.username);
				}
				return resolved;
			}
			// Cognito also resolves `Username` by an email / phone number (an alias,
			// or the sign-in attribute of an email / phone pool). Accept that only
			// when the pool has verified it: a user can set their own email.
			const attribute =
				attributes.email?.toLowerCase() === login.toLowerCase()
					? 'email'
					: attributes.phone_number === login
						? 'phone_number'
						: undefined;
			if (attribute === undefined || attributes[`${attribute}_verified`] !== 'true') {
				throw unverifiedMatch(login, attribute ?? 'email', username);
			}
			resolved.matchedBy = attribute;
			return resolved;
		},
		async groupsOf(username) {
			const groups: string[] = [];
			let NextToken: string | undefined;
			try {
				do {
					const page = await cognito.send(
						new AdminListGroupsForUserCommand({ UserPoolId: id, Username: username, NextToken }),
					);
					for (const g of page.Groups ?? []) if (g.GroupName) groups.push(g.GroupName);
					NextToken = page.NextToken;
				} while (NextToken);
			} catch (e) {
				throw sdkFailure('AdminListGroupsForUser', e);
			}
			return groups.sort();
		},
		async addToGroup(username, group) {
			try {
				await cognito.send(
					new AdminAddUserToGroupCommand({ UserPoolId: id, Username: username, GroupName: group }),
				);
			} catch (e) {
				throw sdkFailure('AdminAddUserToGroup', e);
			}
		},
		async removeFromGroup(username, group) {
			try {
				await cognito.send(
					new AdminRemoveUserFromGroupCommand({ UserPoolId: id, Username: username, GroupName: group }),
				);
			} catch (e) {
				throw sdkFailure('AdminRemoveUserFromGroup', e);
			}
		},
	};
}
