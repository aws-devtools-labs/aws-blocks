// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Production deploy guard. Stops when the binding record differs from the
 * deployed template, then, as a backstop, when a change set would remove or
 * replace a DSQL or Aurora cluster that still has a block on it. Sandbox
 * deploys skip it.
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
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { diffBindings, emptyBindings, formatBindingStop, removedClusterResources } from './bindings.js';
import { bindingsFromTemplate } from './infra/bindings-metadata.js';

/** CloudFormation resource types whose removal or replacement loses data. */
export const GUARDED_RESOURCE_TYPES: ReadonlySet<string> = new Set(['AWS::RDS::DBCluster', 'AWS::DSQL::Cluster']);

/** CloudFormation's inline template-body limit. Larger templates are staged in the CDK assets bucket. */
export const TEMPLATE_BODY_LIMIT = 51200;

/** The CDK bootstrap stack whose assets bucket stages oversized templates. */
const DEFAULT_TOOLKIT_STACK_NAME = 'CDKToolkit';

export interface GuardResult {
	/** Stop messages; empty means the deploy may proceed. */
	stops: string[];
	/** Informational notes (a skipped backstop, a first deploy, a retained cluster let through). */
	notes: string[];
}

/** The subset of the CloudFormation and S3 clients the guard uses; real clients satisfy it. */
export interface GuardClients {
	cloudFormation?: Pick<CloudFormationClient, 'send'>;
	s3?: Pick<S3Client, 'send'>;
}

export interface GuardOptions extends GuardClients {
	stackName: string;
	/** The synthesized template body. */
	template: Record<string, unknown>;
	/** Run the change-set backstop. @default true */
	changeSet?: boolean;
	/** Polling interval for the change set, ms. */
	pollMs?: number;
	/** The CDK bootstrap stack. @default $CDK_TOOLKIT_STACK_NAME or 'CDKToolkit' */
	toolkitStackName?: string;
}

/** The parts of a CloudFormation template body the guard reads. */
export type CfnTemplate = {
	Resources?: Record<string, { Type?: string; DeletionPolicy?: string; Properties?: Record<string, unknown> }>;
	Parameters?: Record<string, { Default?: unknown }>;
	Metadata?: Record<string, unknown>;
};

/**
 * Lower-cased removal policy of the stack's cluster resources, for the binding
 * stop message. `retain` when the clusters disagree, because the message speaks
 * about the stack as a whole; CloudFormation deletes a resource with no policy.
 */
export function clusterRemovalPolicy(template: CfnTemplate | undefined): string {
	const policies = new Set<string>();
	for (const res of Object.values(template?.Resources ?? {})) {
		if (res.Type && GUARDED_RESOURCE_TYPES.has(res.Type))
			policies.add((res.DeletionPolicy ?? 'Delete').toLowerCase());
	}
	return policies.size === 1 ? [...policies][0] : 'retain';
}

/** Lower-cased deletion policy of one deployed resource. CloudFormation deletes when none is set. */
function deletionPolicyOf(template: CfnTemplate | undefined, logicalId: string): string {
	return (template?.Resources?.[logicalId]?.DeletionPolicy ?? 'Delete').toLowerCase();
}

/** The stop message for a destructive change-set entry. */
export function formatResourceStop(change: Change, deployedPolicy: string, ownerRemoved: boolean): string {
	const rc = change.ResourceChange;
	const logicalId = rc?.LogicalResourceId ?? '?';
	const type = rc?.ResourceType ?? '?';
	const action = rc?.Action === 'Remove' ? 'remove' : 'replace';
	const retained =
		deployedPolicy === 'delete' ? 'would be deleted' : `would be retained (removal policy: ${deployedPolicy})`;
	const advice = ownerRemoved
		? "The block that owned it was removed from the code, but the cluster's removal policy is 'destroy', so this deploy would delete its data. " +
			"Deploy once with removalPolicy: 'retain' on the block first, or copy the data out, then remove the block."
		: 'A Database keeps its cluster for life. Revert the change (renaming a Database or DatabaseCluster id replaces its cluster), ' +
			'or add a new Database, copy the data, switch your handlers, then remove the old block.';
	return `Deploy stopped: the change set would ${action} ${type} '${logicalId}'. Its data ${retained}.\n${advice}`;
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

/**
 * Pure part of the backstop: stops from a change set's entries. A `Remove` of a
 * cluster whose owning block (or `DatabaseCluster`) is gone from the new record
 * is allowed when the deployed resource is retained: that is deleting a block,
 * which keeps its data. Any other `Remove`, and every `Replace`, is a stop.
 */
export function changeSetStops(
	changes: Change[] | undefined,
	next: Record<string, unknown>,
	deployed: CfnTemplate | undefined,
): GuardResult {
	const stops: string[] = [];
	const notes: string[] = [];
	const removable = removedClusterResources(
		bindingsFromTemplate(deployed),
		bindingsFromTemplate(next) ?? emptyBindings(),
	);
	for (const change of changes ?? []) {
		const rc = change.ResourceChange;
		if (!rc?.ResourceType || !GUARDED_RESOURCE_TYPES.has(rc.ResourceType)) continue;
		const logicalId = rc.LogicalResourceId ?? '?';
		if (rc.Action === 'Remove') {
			const policy = deletionPolicyOf(deployed, logicalId);
			const ownerRemoved = removable.has(logicalId);
			if (ownerRemoved && policy === 'retain') {
				notes.push(
					`${rc.ResourceType} '${logicalId}' goes with the block that owned it; its data is retained (removal policy: retain).`,
				);
				continue;
			}
			stops.push(formatResourceStop(change, policy, ownerRemoved));
		} else if (rc.Action === 'Modify' && rc.Replacement === 'True') {
			stops.push(formatResourceStop(change, deletionPolicyOf(deployed, logicalId), false));
		}
	}
	return { stops, notes };
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

interface StagedTemplate {
	url: string;
	bucket: string;
	key: string;
}

/**
 * Stage a template larger than the inline limit in the CDK bootstrap assets
 * bucket so the change set can read it by URL. Returns the reason when the
 * bucket cannot be found.
 */
async function stageTemplate(
	cloudFormation: Pick<CloudFormationClient, 'send'>,
	s3: Pick<S3Client, 'send'>,
	toolkitStackName: string,
	stackName: string,
	body: string,
): Promise<StagedTemplate | string> {
	let outputs: { OutputKey?: string; OutputValue?: string }[];
	try {
		const described = await cloudFormation.send(new DescribeStacksCommand({ StackName: toolkitStackName }));
		outputs = described.Stacks?.[0]?.Outputs ?? [];
	} catch (e) {
		return `the CDK bootstrap stack '${toolkitStackName}' could not be read (${e instanceof Error ? e.message : String(e)})`;
	}
	const output = (key: string) => outputs.find((o) => o.OutputKey === key)?.OutputValue;
	const bucket = output('BucketName');
	const domain = output('BucketDomainName');
	if (!bucket || !domain) return `the CDK bootstrap stack '${toolkitStackName}' has no assets bucket outputs`;
	const key = `bb-database-guard/${stackName}/${Date.now()}.template.json`;
	await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json' }));
	return { url: `https://${domain}/${key}`, bucket, key };
}

/** Run the guard against one stack. */
export async function guardDeploy(options: GuardOptions): Promise<GuardResult> {
	const client = options.cloudFormation ?? new CloudFormationClient({});
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

	const parameters = changeSetParameters(template, deployedParams);
	if (parameters === 'unresolvable') {
		notes.push(
			'The template has a parameter with no default and no deployed value; the change-set backstop was skipped.',
		);
		return { stops, notes };
	}

	const body = JSON.stringify(options.template);
	let staged: StagedTemplate | undefined;
	if (body.length > TEMPLATE_BODY_LIMIT) {
		const toolkit = options.toolkitStackName ?? process.env.CDK_TOOLKIT_STACK_NAME ?? DEFAULT_TOOLKIT_STACK_NAME;
		const result = await stageTemplate(client, options.s3 ?? new S3Client({}), toolkit, options.stackName, body);
		if (typeof result === 'string') {
			notes.push(
				`Template is ${body.length} bytes (> ${TEMPLATE_BODY_LIMIT}) and ${result}; the change-set backstop was skipped.`,
			);
			return { stops, notes };
		}
		staged = result;
		notes.push(
			`Template is ${body.length} bytes (> ${TEMPLATE_BODY_LIMIT}); staged at ${staged.url} for the change set.`,
		);
	}

	const changeSetName = `bb-database-guard-${Date.now()}`;
	try {
		await client.send(
			new CreateChangeSetCommand({
				StackName: options.stackName,
				ChangeSetName: changeSetName,
				ChangeSetType: 'UPDATE',
				...(staged ? { TemplateURL: staged.url } : { TemplateBody: body }),
				Parameters: parameters,
				Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
			}),
		);
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
		const result = changeSetStops(changes, options.template, deployed);
		stops.push(...result.stops);
		notes.push(...result.notes);
	} finally {
		await client
			.send(new DeleteChangeSetCommand({ StackName: options.stackName, ChangeSetName: changeSetName }))
			.catch(() => {});
		if (staged) {
			await (options.s3 ?? new S3Client({}))
				.send(new DeleteObjectCommand({ Bucket: staged.bucket, Key: staged.key }))
				.catch(() => {});
		}
	}
	return { stops, notes };
}
