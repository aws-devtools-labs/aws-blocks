// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AwsCredentialIdentity } from '@smithy/types';

/**
 * Optional account details for the deploy commands: the account name, the
 * AWS account plan and whether the caller uses an AWS-managed role from the new
 * AWS sign-up experience. For internal use only.
 *
 * The reads use the credentials that the credential check verified, so they
 * describe the account that the deploy uses. They never stop a deploy. A denied
 * or unsupported request, an empty, partial or malformed response, a timeout and
 * any other error each make a value unavailable. Only the account name, the
 * plan type and status, and the managed-role result are kept: account IDs, ARNs,
 * error messages and credits are dropped, and nothing is stored.
 *
 * The managed-role result is not the account's plan. A plan does not identify
 * these accounts, because other accounts also have one. The managed role does:
 * the new sign-up experience creates it at the path `/managed/`, trusted by
 * `account-access.amazonaws.com`, and keeps it after advanced features are
 * activated. Credentials from a customer-created role or IAM user are not that role.
 */

/** The deployment target, with the credentials that the credential check verified. */
export interface AccountMetadataTarget {
	/**
	 * The deployment Region. It selects the partition: the SDK sends each request to
	 * that partition's endpoint for the service (`us-east-1` in the `aws` partition),
	 * not to an endpoint in this Region.
	 */
	region: string;
	/** The profile passed to the SDK client, if any. */
	profile?: string;
	credentials: AwsCredentialIdentity;
	/** The caller ARN from STS GetCallerIdentity, if the credential check returned it. */
	callerArn?: string;
}

/** The metadata requests. Injectable so tests send no requests. */
export interface AccountMetadataClients {
	/** Account GetAccountInformation for the caller's own account, so no account ID is sent. */
	getAccountInformation(signal: AbortSignal): Promise<unknown>;
	/** Free Tier GetAccountPlanState. */
	getAccountPlanState(signal: AbortSignal): Promise<unknown>;
	/** IAM GetRole for the role that the caller assumed. */
	getRole(roleName: string, signal: AbortSignal): Promise<unknown>;
	/** Close the clients. Called once, also after a timeout. */
	destroy(): void;
}

/** Creates the metadata clients for a target. */
export type AccountMetadataClientFactory = (target: AccountMetadataTarget) => Promise<AccountMetadataClients>;

/** Metadata values ready to print; `null` when unavailable. */
export interface AccountMetadata {
	accountName: string | null;
	/** For example `Free (active)`, or only `Paid` when the status is missing or unknown. */
	plan: string | null;
	/** `true` only when the caller's role is the AWS-managed sign-in role; `false` when that is unknown. */
	managedRole: boolean;
}

/** How long the metadata reads may take in total. */
const METADATA_TIMEOUT_MS = 2500;

const PLAN_TYPES: Record<string, string> = { FREE: 'Free', PAID: 'Paid' };
const PLAN_STATUSES: Record<string, string> = { ACTIVE: 'active', EXPIRED: 'expired', NOT_STARTED: 'not started' };

/** Control and format characters, which can move the cursor or reorder text in a terminal. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/gu;

/** The longest account name that the Account API accepts. */
const MAX_ACCOUNT_NAME_LENGTH = 50;

/** The path and trusted service principal of the AWS-managed roles of the new sign-up experience. */
const MANAGED_ROLE_PATH = '/managed/';
const MANAGED_ROLE_TRUSTED_SERVICE = 'account-access.amazonaws.com';

/** An assumed-role session ARN; the role name is the segment after `assumed-role/`. */
const ASSUMED_ROLE_ARN = /^arn:[^:]+:sts::\d{12}:assumed-role\/([^/]+)\/[^/]+$/;

/** Default clients: the AWS SDK, with one attempt and short timeouts. */
export const sdkAccountMetadataClients: AccountMetadataClientFactory = async ({ region, profile, credentials }) => {
	// Loaded on demand, like the STS client, so that the dev server and mock tests never load them.
	const [
		{ AccountClient, GetAccountInformationCommand },
		{ FreeTierClient, GetAccountPlanStateCommand },
		{ IAMClient, GetRoleCommand },
	] = await Promise.all([
		import('@aws-sdk/client-account'),
		import('@aws-sdk/client-freetier'),
		import('@aws-sdk/client-iam'),
	]);
	const config = {
		region,
		profile,
		credentials,
		maxAttempts: 1,
		// Without throwOnRequestTimeout the handler only logs a warning when the request times out.
		requestHandler: { connectionTimeout: 1000, requestTimeout: 2000, throwOnRequestTimeout: true },
	};
	const account = new AccountClient(config);
	const freeTier = new FreeTierClient(config);
	const iam = new IAMClient(config);
	return {
		getAccountInformation: (abortSignal) => account.send(new GetAccountInformationCommand({}), { abortSignal }),
		getAccountPlanState: (abortSignal) => freeTier.send(new GetAccountPlanStateCommand({}), { abortSignal }),
		getRole: (RoleName, abortSignal) => iam.send(new GetRoleCommand({ RoleName }), { abortSignal }),
		destroy: () => {
			account.destroy();
			freeTier.destroy();
			iam.destroy();
		},
	};
};

/** A property of an SDK response, which may not be an object. */
function field(response: unknown, key: string): unknown {
	return typeof response === 'object' && response !== null ? Reflect.get(response, key) : undefined;
}

function accountName(response: unknown): string | null {
	const name = field(response, 'AccountName');
	if (typeof name !== 'string') return null;
	return name.replace(UNPRINTABLE, '').trim().slice(0, MAX_ACCOUNT_NAME_LENGTH) || null;
}

function planLabel(response: unknown): string | null {
	const type = field(response, 'accountPlanType');
	if (typeof type !== 'string' || !Object.hasOwn(PLAN_TYPES, type)) return null;
	const status = field(response, 'accountPlanStatus');
	return typeof status === 'string' && Object.hasOwn(PLAN_STATUSES, status)
		? `${PLAN_TYPES[type]} (${PLAN_STATUSES[status]})`
		: PLAN_TYPES[type];
}

/** Whether a GetRole response is an AWS-managed sign-in role: its path and its trust policy. */
function isManagedRole(response: unknown): boolean {
	const role = field(response, 'Role');
	if (field(role, 'Path') !== MANAGED_ROLE_PATH) return false;
	const document = field(role, 'AssumeRolePolicyDocument');
	if (typeof document !== 'string') return false;
	let policy: unknown;
	try {
		// IAM returns the trust policy URL-encoded.
		policy = JSON.parse(decodeURIComponent(document));
	} catch {
		return false;
	}
	const statements = field(policy, 'Statement');
	return (Array.isArray(statements) ? statements : [statements]).some((statement) => {
		// The service principal may be a string or a list; each entry must equal the service exactly.
		const service = field(field(statement, 'Principal'), 'Service');
		return (
			field(statement, 'Effect') === 'Allow' &&
			(Array.isArray(service) ? service : [service]).some((value) => value === MANAGED_ROLE_TRUSTED_SERVICE)
		);
	});
}

/** Options for {@link readAccountMetadata}. */
export interface ReadAccountMetadataOptions {
	clients?: AccountMetadataClientFactory;
	timeoutMs?: number;
}

/**
 * Read the account name, the plan and, for an assumed role, the role, in parallel.
 * Never throws, and returns within the timeout. At the timeout, requests still
 * running are cancelled, their values are unavailable, and the clients are closed.
 */
export async function readAccountMetadata(
	target: AccountMetadataTarget,
	{ clients: create = sdkAccountMetadataClients, timeoutMs = METADATA_TIMEOUT_MS }: ReadAccountMetadataOptions = {},
): Promise<AccountMetadata> {
	const metadata: AccountMetadata = { accountName: null, plan: null, managedRole: false };
	// IAM users, the root user and other ARNs have no role to read.
	const roleName = target.callerArn ? ASSUMED_ROLE_ARN.exec(target.callerArn)?.[1] : undefined;
	const controller = new AbortController();
	let clients: AccountMetadataClients | undefined;
	let finished = false;
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});
	const reads = create(target).then((created) => {
		if (finished) {
			created.destroy();
			return;
		}
		clients = created;
		return Promise.allSettled([
			(async () => {
				metadata.accountName = accountName(await created.getAccountInformation(controller.signal));
			})(),
			(async () => {
				metadata.plan = planLabel(await created.getAccountPlanState(controller.signal));
			})(),
			(async () => {
				if (roleName) metadata.managedRole = isManagedRole(await created.getRole(roleName, controller.signal));
			})(),
		]);
	});
	try {
		await Promise.race([reads.catch(() => {}), deadline]);
	} finally {
		finished = true;
		clearTimeout(timer);
		controller.abort();
		clients?.destroy();
	}
	// A copy, so that a request that ignores the cancellation cannot change the result.
	return { ...metadata };
}
