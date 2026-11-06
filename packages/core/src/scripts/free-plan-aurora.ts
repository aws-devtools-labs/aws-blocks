// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AccountPlanType } from './account-metadata.js';
import { stackTemplates, type TemplateResource } from './cloud-assembly.js';
import { log } from './log.js';

/**
 * Stops a deploy to a Free-plan account that would create an Aurora cluster
 * CloudFormation cannot create there. On the Free plan, RDS creates Aurora
 * clusters only with express configuration, and rejects any other with "To use
 * Aurora clusters with free plan accounts you need to set
 * WithExpressConfiguration". The deploy commands run this check on the
 * synthesized assembly before deploying it, so the deploy stops before any
 * stack is created or changed.
 *
 * Only a certain failure stops the deploy: a literal Aurora engine with
 * `WithExpressConfiguration` absent or false, on a resource without a
 * `Condition`. `AWS::RDS::DBCluster` also models RDS Multi-AZ DB clusters, and
 * the Free-plan rule is Aurora's, so other engines are left alone. A value only
 * known at deploy time (an intrinsic function or parameter) or a conditional
 * resource gets a warning, and the deploy continues.
 */

export const AURORA_FREE_TIER_URL =
	'https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-free-tier.html';
export const FREE_PLAN_UPGRADE_URL =
	'https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html#freeplan-upgrade';

/** How a resource fares on a Free-plan account. */
export type FreePlanAuroraVerdict =
	/** Not an Aurora cluster, or one with express configuration. */
	| 'allowed'
	/** A literal Aurora cluster without express configuration: RDS rejects it. */
	| 'blocked'
	/** An Aurora cluster, or possibly one, whose outcome is decided at deploy time. */
	| 'undecided';

/** A DB cluster in a synthesized template, for the messages. */
export interface FreePlanAuroraCluster {
	stackName: string;
	/** The account the stack targets, when it names one (`env.account`). */
	account?: string;
	logicalId: string;
	/** The construct path from the `aws:cdk:path` metadata, when the template has it. */
	path?: string;
}

/** The DB clusters of an assembly that a Free-plan account blocks or might block. */
export interface FreePlanAuroraFindings {
	blocked: FreePlanAuroraCluster[];
	undecided: FreePlanAuroraCluster[];
	/**
	 * Clusters, `blocked` or `undecided`, in stacks that target an account other
	 * than the one whose plan was read, or that cannot be matched to it. That
	 * account's plan is unknown, so they never stop the deploy.
	 */
	otherAccount: FreePlanAuroraCluster[];
}

/**
 * How a template resource fares on a Free-plan account. Anything other than an
 * `AWS::RDS::DBCluster` is `allowed`.
 */
export function freePlanAuroraVerdict(resource: TemplateResource): FreePlanAuroraVerdict {
	if (resource.Type !== 'AWS::RDS::DBCluster') return 'allowed';
	const engine = resource.Properties?.Engine;
	if (typeof engine !== 'string') return 'undecided';
	if (!engine.toLowerCase().startsWith('aurora')) return 'allowed';
	const express = resource.Properties?.WithExpressConfiguration;
	if (express === true || express === 'true') return 'allowed';
	if (express !== undefined && express !== false && express !== 'false') return 'undecided';
	// A conditional resource may not be created at all.
	return resource.Condition === undefined ? 'blocked' : 'undecided';
}

/**
 * The DB clusters in the top-level stacks of the synthesized assembly at
 * `assemblyDir`. `account` is the account whose plan was read: an
 * environment-agnostic stack deploys there, and so does a stack that names it.
 * A stack that names any other account, or any account when `account` is
 * unknown, goes to `otherAccount`.
 */
export function findFreePlanAuroraClusters(assemblyDir: string, account: string | null): FreePlanAuroraFindings {
	const findings: FreePlanAuroraFindings = { blocked: [], undecided: [], otherAccount: [] };
	for (const { stack, account: target, template } of stackTemplates(assemblyDir)) {
		const planApplies = target === undefined || target === account;
		for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
			const verdict = freePlanAuroraVerdict(resource);
			if (verdict === 'allowed') continue;
			const path = resource.Metadata?.['aws:cdk:path'];
			findings[planApplies ? verdict : 'otherAccount'].push({
				stackName: stack.stackName,
				...(target ? { account: target } : {}),
				logicalId,
				...(typeof path === 'string' ? { path } : {}),
			});
		}
	}
	return findings;
}

function clusterLines(clusters: FreePlanAuroraCluster[]): string[] {
	return clusters.map(
		({ stackName, account, logicalId, path }) =>
			`    ${stackName}${account ? ` (account ${account})` : ''}: ${path ?? logicalId}`,
	);
}

/** The message that stops the deploy. */
export function freePlanAuroraStopMessage(invocation: string, blocked: FreePlanAuroraCluster[]): string {
	return [
		`\`${invocation}\` stopped before deploying: this AWS account is on the Free plan, where Aurora clusters ` +
			'can only be created with express configuration, and the app defines Aurora clusters without it:',
		...clusterLines(blocked),
		'  No stack was deployed. To deploy this app, do one of these:',
		`    - Upgrade the account to the Paid plan: ${FREE_PLAN_UPGRADE_URL}`,
		'    - Use DistributedDatabase (Aurora DSQL), which deploys on the Free plan, instead of Database.',
		'    - Connect Database to an existing PostgreSQL database with fromExisting({ connectionString }).',
		`  See ${AURORA_FREE_TIER_URL}`,
		`Then re-run \`${invocation}\`.`,
	].join('\n');
}

/** The warning for clusters whose outcome on a Free-plan account is decided at deploy time. */
export function freePlanAuroraUndecidedWarning(invocation: string, undecided: FreePlanAuroraCluster[]): string {
	return [
		'⚠️  This AWS account is on the Free plan, where Aurora clusters can only be created with express configuration. ' +
			`For these DB clusters that is decided at deploy time, so \`${invocation}\` continues:`,
		...clusterLines(undecided),
		'   If the deploy fails with "To use Aurora clusters with free plan accounts you need to set ' +
			`WithExpressConfiguration", see ${AURORA_FREE_TIER_URL}`,
	].join('\n');
}

/** The warning for clusters in stacks that deploy to an account whose plan was not read. */
export function freePlanAuroraOtherAccountWarning(invocation: string, clusters: FreePlanAuroraCluster[]): string {
	return [
		'⚠️  The AWS account of these credentials is on the Free plan, but these DB clusters are in stacks that ' +
			`name another account, or one the credential check could not match to it, so \`${invocation}\` ` +
			'does not check them and continues:',
		...clusterLines(clusters),
		'   If that account is on the Free plan too, Aurora clusters there need express configuration. ' +
			`See ${AURORA_FREE_TIER_URL}`,
	].join('\n');
}

/** Options for {@link assertFreePlanAurora}. */
export interface FreePlanAuroraCheckOptions {
	/** The account plan type from the credential check; `null` when unavailable. */
	accountPlan: AccountPlanType | null;
	/** The account the credential check verified, whose plan `accountPlan` is; `null` when unknown. */
	account: string | null;
	/** The synthesized cloud assembly about to be deployed. */
	assemblyDir: string;
	/** How the user runs the deploy, in the messages (for example `npm run deploy`). */
	invocation: string;
}

/**
 * On a Free-plan account, stop the deploy when the assembly creates an Aurora
 * cluster without express configuration in that account, and warn about
 * clusters whose outcome is decided at deploy time. Stacks that target another
 * account (`env.account`, deployed through its bootstrap roles) get a warning
 * instead, because only the credentials' own plan was read. Does nothing on a
 * Paid plan or when the plan is unavailable: a plan read that is denied or
 * times out must not slow or block a deploy that may be fine.
 *
 * @throws {Error} With the clusters and the ways forward, when the deploy would fail.
 */
export function assertFreePlanAurora({
	accountPlan,
	account,
	assemblyDir,
	invocation,
}: FreePlanAuroraCheckOptions): void {
	if (accountPlan !== 'FREE') return;
	const { blocked, undecided, otherAccount } = findFreePlanAuroraClusters(assemblyDir, account);
	if (blocked.length > 0) throw new Error(freePlanAuroraStopMessage(invocation, blocked));
	if (undecided.length > 0) log.warn(freePlanAuroraUndecidedWarning(invocation, undecided));
	if (otherAccount.length > 0) log.warn(freePlanAuroraOtherAccountWarning(invocation, otherAccount));
}
