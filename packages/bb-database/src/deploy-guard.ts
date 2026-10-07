// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The deploy guard: runs before `cdk deploy` in the production stage and stops
 * a deploy that would move a `Database` to another cluster or destroy a
 * cluster resource.
 *
 * 1. Read the synthesized template's binding record.
 * 2. If the stack exists, fetch the deployed template and diff `databases` and
 *    `clusters`. Any entry whose cluster id or type differs is a stop.
 * 3. Create a change set, scan it for `Remove` or `Replace` on
 *    `AWS::RDS::DBCluster` / `AWS::DSQL::Cluster`, delete the change set. This
 *    is the backstop for a destructive change the record diff does not express.
 * 4. Stop with the message, or proceed.
 *
 * The sandbox stage never runs the guard; the dev server keeps the record check
 * through the per-block marker (see `bindings.ts`).
 */
import {
	type Change,
	CloudFormationClient,
	CreateChangeSetCommand,
	DeleteChangeSetCommand,
	DescribeChangeSetCommand,
	DescribeStacksCommand,
	GetTemplateCommand,
	type Parameter,
} from '@aws-sdk/client-cloudformation';
import { diffBindings, emptyBindings, formatBindingStop } from './bindings.js';
import { bindingsFromTemplate } from './infra/bindings-metadata.js';

/** CloudFormation resource types whose removal or replacement loses data. */
export const GUARDED_RESOURCE_TYPES: ReadonlySet<string> = new Set(['AWS::RDS::DBCluster', 'AWS::DSQL::Cluster']);

/** CloudFormation's inline template-body limit. Larger templates skip the change-set backstop. */
const TEMPLATE_BODY_LIMIT = 51200;

/** Aurora Serverless v2 list price per ACU-hour (us-east-1), used for the orphaned-cluster estimate. */
const ACU_HOUR_USD = 0.12;
const HOURS_PER_MONTH = 730;

export interface GuardResult {
	/** Stop messages; empty means the deploy may proceed. */
	stops: string[];
	/** Informational notes (a skipped backstop, a first deploy). */
	notes: string[];
}

export interface GuardOptions {
	stackName: string;
	/** The synthesized template body. */
	template: Record<string, unknown>;
	client?: CloudFormationClient;
	/** Run the change-set backstop. @default true */
	changeSet?: boolean;
	/** Polling interval for the change set, ms. */
	pollMs?: number;
}

/** The parts of a CloudFormation template body the guard reads. */
export type CfnTemplate = {
	Resources?: Record<string, { Type?: string; DeletionPolicy?: string; Properties?: Record<string, unknown> }>;
	Parameters?: Record<string, { Default?: unknown }>;
};

/** Lower-cased removal policy of the stack's cluster resources, when they agree. */
export function clusterRemovalPolicy(template: CfnTemplate | undefined): string {
	const policies = new Set<string>();
	for (const res of Object.values(template?.Resources ?? {})) {
		if (res.Type && GUARDED_RESOURCE_TYPES.has(res.Type))
			policies.add((res.DeletionPolicy ?? 'Retain').toLowerCase());
	}
	return policies.size === 1 ? [...policies][0] : 'retain';
}

/** Monthly cost estimate of leaving a provisioned cluster orphaned, from its minimum capacity. */
export function orphanedClusterCost(resource: { Properties?: Record<string, unknown> } | undefined): string {
	const scaling = resource?.Properties?.ServerlessV2ScalingConfiguration as { MinCapacity?: number } | undefined;
	const acu = typeof scaling?.MinCapacity === 'number' ? scaling.MinCapacity : 0.5;
	const usd = acu * ACU_HOUR_USD * HOURS_PER_MONTH;
	return `about $${usd.toFixed(2)}/month at ${acu} ACU (us-east-1 list price, estimate)`;
}

/** The stop message for a destructive change-set entry. */
export function formatResourceStop(change: Change, template: CfnTemplate, deployedPolicy: string): string {
	const rc = change.ResourceChange;
	const logicalId = rc?.LogicalResourceId ?? '?';
	const type = rc?.ResourceType ?? '?';
	const action = rc?.Action === 'Remove' ? 'remove' : 'replace';
	const resource = template.Resources?.[logicalId];
	const retained =
		deployedPolicy === 'delete' ? 'would be deleted' : `would be retained (removal policy: ${deployedPolicy})`;
	const cost = type === 'AWS::RDS::DBCluster' ? ` Leaving it orphaned costs ${orphanedClusterCost(resource)}.` : '';
	return (
		`Deploy stopped: the change set would ${action} ${type} '${logicalId}'. Its data ${retained}.${cost}\n` +
		'A Database keeps its cluster for life. Revert the change, or add a new Database, copy the data, switch your handlers, then remove the old block.'
	);
}

/** Pure part of the guard: stops from the binding-record diff. */
export function bindingStops(deployed: CfnTemplate | undefined, next: Record<string, unknown>): string[] {
	const nextBindings = bindingsFromTemplate(next) ?? emptyBindings();
	const deployedBindings = bindingsFromTemplate(deployed);
	const policy = clusterRemovalPolicy(deployed);
	return diffBindings(deployedBindings, nextBindings).map((change) =>
		formatBindingStop(change, { removalPolicy: policy }),
	);
}

/** Pure part of the backstop: stops from a change set's entries. */
export function changeSetStops(changes: Change[] | undefined, template: CfnTemplate, deployedPolicy: string): string[] {
	const stops: string[] = [];
	for (const change of changes ?? []) {
		const rc = change.ResourceChange;
		if (!rc?.ResourceType || !GUARDED_RESOURCE_TYPES.has(rc.ResourceType)) continue;
		const destructive = rc.Action === 'Remove' || (rc.Action === 'Modify' && rc.Replacement === 'True');
		if (destructive) stops.push(formatResourceStop(change, template, deployedPolicy));
	}
	return stops;
}

function isStackMissing(e: unknown): boolean {
	return e instanceof Error && /does not exist/i.test(e.message);
}

/** Parameters for the change set: previous values for parameters the deployed stack already has. */
function changeSetParameters(template: CfnTemplate, deployedParams: Set<string>): Parameter[] | 'unresolvable' {
	const out: Parameter[] = [];
	for (const [name, def] of Object.entries(template.Parameters ?? {})) {
		if (deployedParams.has(name)) out.push({ ParameterKey: name, UsePreviousValue: true });
		else if (def.Default === undefined) return 'unresolvable';
	}
	return out;
}

/** Run the guard against one stack. */
export async function guardDeploy(options: GuardOptions): Promise<GuardResult> {
	const client = options.client ?? new CloudFormationClient({});
	const notes: string[] = [];
	const template = options.template as CfnTemplate;

	let deployedParams = new Set<string>();
	try {
		const described = await client.send(new DescribeStacksCommand({ StackName: options.stackName }));
		deployedParams = new Set((described.Stacks?.[0]?.Parameters ?? []).map((p) => p.ParameterKey ?? ''));
	} catch (e) {
		if (isStackMissing(e))
			return {
				stops: [],
				notes: [`Stack ${options.stackName} does not exist yet: first deploy, nothing to guard.`],
			};
		throw e;
	}

	const got = await client.send(new GetTemplateCommand({ StackName: options.stackName, TemplateStage: 'Original' }));
	let deployed: CfnTemplate | undefined;
	try {
		deployed = got.TemplateBody ? (JSON.parse(got.TemplateBody) as CfnTemplate) : undefined;
	} catch {
		notes.push('The deployed template is not JSON; the binding-record diff was skipped.');
	}

	const stops = bindingStops(deployed, options.template);
	if (stops.length > 0 || options.changeSet === false) return { stops, notes };

	const body = JSON.stringify(options.template);
	if (body.length > TEMPLATE_BODY_LIMIT) {
		notes.push(`Template is ${body.length} bytes (> ${TEMPLATE_BODY_LIMIT}); the change-set backstop was skipped.`);
		return { stops, notes };
	}
	const parameters = changeSetParameters(template, deployedParams);
	if (parameters === 'unresolvable') {
		notes.push(
			'The template has a parameter with no default and no deployed value; the change-set backstop was skipped.',
		);
		return { stops, notes };
	}

	const changeSetName = `bb-database-guard-${Date.now()}`;
	await client.send(
		new CreateChangeSetCommand({
			StackName: options.stackName,
			ChangeSetName: changeSetName,
			ChangeSetType: 'UPDATE',
			TemplateBody: body,
			Parameters: parameters,
			Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
		}),
	);
	try {
		const changes: Change[] = [];
		let nextToken: string | undefined;
		for (;;) {
			const described = await client.send(
				new DescribeChangeSetCommand({
					StackName: options.stackName,
					ChangeSetName: changeSetName,
					NextToken: nextToken,
				}),
			);
			if (described.Status === 'CREATE_PENDING' || described.Status === 'CREATE_IN_PROGRESS') {
				await new Promise((r) => setTimeout(r, options.pollMs ?? 2000));
				continue;
			}
			if (described.Status === 'FAILED') {
				if (!/didn't contain changes|No updates are to be performed/i.test(described.StatusReason ?? '')) {
					notes.push(
						`Change set failed (${described.StatusReason ?? 'unknown reason'}); the backstop was skipped.`,
					);
				}
				break;
			}
			changes.push(...(described.Changes ?? []));
			nextToken = described.NextToken;
			if (!nextToken) break;
		}
		stops.push(...changeSetStops(changes, template, clusterRemovalPolicy(deployed)));
	} finally {
		await client
			.send(new DeleteChangeSetCommand({ StackName: options.stackName, ChangeSetName: changeSetName }))
			.catch(() => {});
	}
	return { stops, notes };
}
