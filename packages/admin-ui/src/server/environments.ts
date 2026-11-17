// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { awsClientConfig } from './aws-config.js';

/**
 * Environments (M3, read-only): per-stage stack state via DescribeStacks.
 * Drift is REPORTED from the stack's last known drift information — the
 * dashboard never triggers DetectStackDrift (it's slow, and kicking off
 * scans implicitly would be a surprising side effect for a read-only view).
 */

/** What we consume from DescribeStacks. */
export interface RawStackDescription {
	StackStatus?: string;
	CreationTime?: Date;
	LastUpdatedTime?: Date;
	DriftInformation?: { StackDriftStatus?: string; LastCheckTimestamp?: Date };
	Outputs?: Array<{ OutputKey?: string; OutputValue?: string }>;
}

/** Output keys worth surfacing on the environment card. */
const INTERESTING_OUTPUT_PATTERN = /url/i;

export function selectInterestingOutputs(description: RawStackDescription): Record<string, string> | undefined {
	const outputs: Record<string, string> = {};
	for (const output of description.Outputs ?? []) {
		if (output.OutputKey && output.OutputValue && INTERESTING_OUTPUT_PATTERN.test(output.OutputKey)) {
			outputs[output.OutputKey] = output.OutputValue;
		}
	}
	return Object.keys(outputs).length > 0 ? outputs : undefined;
}

export function stackConsoleUrl(stackName: string, region: string): string {
	return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks?filteringText=${encodeURIComponent(stackName)}`;
}

/** True when the error is CloudFormation's "stack does not exist". */
export function isStackNotFound(error: unknown): boolean {
	const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	return /does not exist/i.test(message);
}

/** Fetches one stack's description. Throws on AWS errors (incl. not-found). */
export async function fetchStackDescription(stackName: string, region?: string): Promise<RawStackDescription> {
	const { CloudFormationClient, DescribeStacksCommand } = await import('@aws-sdk/client-cloudformation');
	const client = new CloudFormationClient(awsClientConfig(region));
	const result = await client.send(new DescribeStacksCommand({ StackName: stackName }));
	const stack = result.Stacks?.[0];
	if (!stack) throw new Error(`Stack ${stackName} does not exist`);
	return stack;
}
