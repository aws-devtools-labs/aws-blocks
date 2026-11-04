// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where each stage's deployment actually lives, read from that stage's own CDK
 * outputs document.
 *
 * SOURCE OF TRUTH: `packages/core/src/scripts/deploy-outputs.ts`, which owns the
 * per-stage outputs paths and selects a stack by the output it carries. This
 * is a deliberate reimplementation rather than an import, for the same reason
 * `rpc-codec.ts` reimplements the wire format: `admin-ui` does not depend on
 * `@aws-blocks/core` and must not start, because the dashboard installs into a
 * *user's* project and a core dependency would have to match whichever core
 * version that app pins. The cost of that independence is drift, so it is paid
 * for explicitly — `stage-outputs.test.ts` cross-checks {@link OUTPUTS_FILE} and
 * {@link BACKEND_OUTPUT_KEY} against core's own values when core's build is
 * resolvable (i.e. inside this monorepo), and skips that check rather than
 * failing when it is not.
 *
 * ## Why this file exists at all
 *
 * The dashboard used to take a stage's region from the deploy *record*
 * (`.blocks/deploy-history.jsonl`), which re-derives the region at deploy time
 * through `resolveRegion()` — env, then `aws configure get region`, then a
 * hardcoded `us-east-1`. That resolution can disagree with the region CDK
 * actually deployed to, and once written, a wrong region is indistinguishable
 * from a right one: the dashboard then queries a region the stack is not in,
 * CloudFormation answers "does not exist", and that gets rendered as
 * **"not deployed"** about a stack that is standing.
 *
 * A CDK outputs document is not a re-derivation. It is written by the CDK CLI
 * from the real CloudFormation outputs of the stack it just created, so
 * `ApiUrl`'s own hostname carries the region that stack is in. That is why the
 * region is read from the outputs rather than resolved again here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A deployment stage. `production` is `npm run deploy`; `sandbox` is `npm run sandbox`. */
export type DeployStage = 'sandbox' | 'production';

/**
 * Each stage's `cdk deploy --outputs-file` document, relative to the project root.
 *
 * MUST match `OUTPUTS_FILE` in core's `deploy-outputs.ts`; the drift test pins
 * that. Two distinct names, because the CDK CLI replaces this document with the
 * stacks of one invocation instead of merging — and writes it from a `finally`
 * block, so even a failed deploy writes. A shared file therefore let each stage
 * erase the other's record, which is the defect that made the dashboard read
 * production's values for the sandbox.
 */
export const OUTPUTS_FILE: Readonly<Record<DeployStage, string>> = Object.freeze({
	sandbox: '.blocks-sandbox/outputs.json',
	production: '.blocks-sandbox/outputs.production.json',
});

/** The command that writes a given stage's outputs file, named in every reason string. */
export const WRITER_COMMAND: Readonly<Record<DeployStage, string>> = Object.freeze({
	sandbox: 'npm run sandbox',
	production: 'npm run deploy',
});

/**
 * The output every Blocks backend stack publishes. It identifies the backend
 * stack among the stacks of one deploy without knowing its name — which matters
 * because the name is the CDK app's choice, not ours.
 */
export const BACKEND_OUTPUT_KEY = 'ApiUrl';

/** Absolute path of a stage's outputs file within a project. */
export function outputsFilePath(stage: DeployStage, projectRoot: string): string {
	return join(projectRoot, ...OUTPUTS_FILE[stage].split('/'));
}

/**
 * Outcome of reading one stage's outputs document.
 *
 * `no-record` and `unusable` are deliberately distinct, and the distinction is
 * load-bearing for what the UI may claim. "This checkout has no record of a
 * deploy" is a fact about local state, and is the one case where the stage's
 * stack name may be *derived* instead. "The file is there but holds no single
 * backend stack" is a question only the user can settle — an empty document from
 * a failed deploy, two candidate stacks, malformed JSON — and answering it with
 * a guess would throw away the diagnosis.
 */
export type StageOutputsStatus = 'found' | 'no-record' | 'unusable';

export interface StageOutputsResult {
	status: StageOutputsStatus;
	/** Absolute path read (or attempted), named in every reason string. */
	outputsFile: string;
	/** The backend stack's name as CDK recorded it. Only on `found`. */
	stackName?: string;
	/** That stack's CloudFormation outputs. Only on `found`. */
	outputs?: Record<string, string>;
	/** Why the read did not yield a backend stack. Absent on `found`. */
	reason?: string;
}

/**
 * Read a stage's backend stack from that stage's own outputs document.
 *
 * Selection is **by the output the stack publishes**, never by position in the
 * file. `Object.values(doc)[0]` was the old rule and it picked whichever stack
 * serialized first, which `cdk deploy --all` can make the wrong one: an app with
 * a Lambda@Edge route synthesizes an `edge-lambda-stack-*` beside the backend
 * stack, and that stack publishes no `ApiUrl`. Zero matches and several matches
 * are both reported, never resolved by guessing.
 */
export function readStageOutputs(projectRoot: string, stage: DeployStage): StageOutputsResult {
	const outputsFile = outputsFilePath(stage, projectRoot);

	let raw: string;
	try {
		raw = readFileSync(outputsFile, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return {
				status: 'no-record',
				outputsFile,
				reason: `No ${stage} outputs file at ${OUTPUTS_FILE[stage]} — it is written by \`${WRITER_COMMAND[stage]}\`, so this checkout holds no record of a ${stage} deploy.`,
			};
		}
		return {
			status: 'unusable',
			outputsFile,
			reason: `Could not read ${OUTPUTS_FILE[stage]}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	let document: unknown;
	try {
		document = JSON.parse(raw);
	} catch (error) {
		return {
			status: 'unusable',
			outputsFile,
			reason: `${OUTPUTS_FILE[stage]} is not valid JSON: ${(error as Error).message}`,
		};
	}

	if (document === null || typeof document !== 'object' || Array.isArray(document)) {
		return {
			status: 'unusable',
			outputsFile,
			reason: `${OUTPUTS_FILE[stage]} is not a CDK outputs document (expected an object keyed by stack name, got ${
				Array.isArray(document) ? 'an array' : typeof document
			}).`,
		};
	}

	const entries = Object.entries(document as Record<string, unknown>);

	if (entries.length === 0) {
		return {
			status: 'unusable',
			outputsFile,
			reason: `${OUTPUTS_FILE[stage]} holds no stacks. The CDK CLI writes this file even when a deploy fails, and a deploy that failed on its first stack writes an empty document — so this most likely means the last ${stage} deploy failed. Re-run \`${WRITER_COMMAND[stage]}\`.`,
		};
	}

	const matches = entries.filter(
		([, outputs]) =>
			outputs !== null &&
			typeof outputs === 'object' &&
			!Array.isArray(outputs) &&
			typeof (outputs as Record<string, unknown>)[BACKEND_OUTPUT_KEY] === 'string',
	);
	const names = entries.map(([name]) => `"${name}"`).join(', ');

	if (matches.length === 0) {
		return {
			status: 'unusable',
			outputsFile,
			reason: `${OUTPUTS_FILE[stage]} has no stack publishing the ${BACKEND_OUTPUT_KEY} output — it holds ${names}. Re-run \`${WRITER_COMMAND[stage]}\`.`,
		};
	}
	if (matches.length > 1) {
		return {
			status: 'unusable',
			outputsFile,
			reason: `${OUTPUTS_FILE[stage]} has ${matches.length} stacks publishing the ${BACKEND_OUTPUT_KEY} output (${matches
				.map(([name]) => `"${name}"`)
				.join(', ')}); refusing to guess which one is the backend.`,
		};
	}

	const [stackName, outputs] = matches[0];
	return { status: 'found', outputsFile, stackName, outputs: outputs as Record<string, string> };
}

/** `arn:<partition>:<service>:<region>:<account>:…` — the region is field 4. */
const ARN_REGION = /^arn:[^:]*:[^:]*:([a-z]{2}(?:-[a-z]+)+-\d):/;

/**
 * A regional AWS hostname: `…execute-api.eu-west-1.amazonaws.com`,
 * `sqs.us-east-1.amazonaws.com`. Anchored on `.amazonaws.com` so a CloudFront
 * domain or a bucket name cannot match.
 */
const HOST_REGION = /\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com/;

/** The region a single output value implies, if it carries one at all. */
function regionOf(value: string): string | undefined {
	return ARN_REGION.exec(value)?.[1] ?? HOST_REGION.exec(value)?.[1];
}

export interface OutputsRegion {
	region?: string;
	/** Why no region could be read. Absent when `region` is set. */
	reason?: string;
}

/**
 * The region a backend stack's outputs place it in.
 *
 * **{@link BACKEND_OUTPUT_KEY} decides, and nothing else gets a vote.** It is
 * the output that identified this stack, every Blocks backend stack has it, and
 * it is an API Gateway URL in the stack's own region. Polling the other outputs
 * instead would be strictly worse: a hosting app legitimately publishes a
 * `us-east-1` SNS topic ARN for the CloudFront alarm that must live there
 * (D-016), so "every output agrees or we give up" would throw away a region we
 * can read exactly, in precisely the apps that have the most to show.
 *
 * The remaining outputs are consulted only when `ApiUrl` carries no region at
 * all, and then unanimously or not at all — a disagreement there is genuinely
 * undecidable, and a wrong region is the failure this whole module exists to
 * prevent.
 */
export function regionFromOutputs(outputs: Record<string, string>): OutputsRegion {
	const fromApi = typeof outputs[BACKEND_OUTPUT_KEY] === 'string' ? regionOf(outputs[BACKEND_OUTPUT_KEY]) : undefined;
	if (fromApi) return { region: fromApi };

	const others = new Set<string>();
	for (const [key, value] of Object.entries(outputs)) {
		if (key === BACKEND_OUTPUT_KEY || typeof value !== 'string') continue;
		const region = regionOf(value);
		if (region) others.add(region);
	}

	if (others.size === 1) return { region: [...others][0] };
	if (others.size === 0) {
		return {
			reason: `No output names a region (${BACKEND_OUTPUT_KEY} is not a regional URL, and the rest are region-free values such as a CloudFront domain or a bucket name).`,
		};
	}
	return {
		reason: `Outputs disagree on the region (${[...others].sort().join(', ')}) and ${BACKEND_OUTPUT_KEY} names none, so the stack's region cannot be read from them.`,
	};
}

/** Which tier of {@link resolveStageRegion} supplied the region. */
export type RegionSource = 'cli' | 'env' | 'outputs' | 'none';

export interface StageRegion {
	/** The region to query this stage in. Absent means no tier supplied one. */
	region?: string;
	source: RegionSource;
	/** The outputs read for this stage — its status also decides `not-deployed` vs `unknown`. */
	outputs: StageOutputsResult;
	/** Why no region was resolved. Absent when `region` is set. */
	reason?: string;
}

/**
 * The region to query one stage in, and where that region came from.
 *
 * ```
 * 1. --region            (BLOCKS_DASHBOARD_REGION)  explicit intent, wins over everything
 * 2. AWS_REGION / AWS_DEFAULT_REGION                an exported variable is also intent
 * 3. that stage's own CDK outputs document          CDK's own answer, per stage
 * 4. nothing                                        this stage has no deployment here
 * ```
 *
 * Two properties of this ordering are worth stating, because both were decided
 * rather than fallen into.
 *
 * **The deploy record's `region` is not a tier.** It is a re-derivation of the
 * region through a resolver that can disagree with CDK's, and a wrong value
 * there is indistinguishable from a right one. Tier 3 reads the artifact CDK
 * itself wrote. The recorded field stays in the history for the deployments
 * list, but nothing resolves a region from it any more.
 *
 * **`AWS_REGION` above the outputs document is a deliberate trade.** A stale
 * `AWS_REGION` in a shell beats CDK's own answer and can reproduce the
 * wrong-region symptom by a different route. It is kept above tier 3 anyway: an
 * explicitly exported variable is the same class of statement as the flag, and
 * silently overruling it would make the dashboard disagree with every `aws`
 * command run in the same shell.
 *
 * Tier 4 is a real outcome, not an error. With no region stated and no outputs
 * document, there is nothing to look up and nothing to look it up *in* — so the
 * honest report is that this stage has no deployment recorded here, and the
 * caller must say which stage and why rather than implying nothing is deployed
 * anywhere.
 */
export function resolveStageRegion(
	projectRoot: string,
	stage: DeployStage,
	env: { cli?: string; env?: string },
): StageRegion {
	const outputs = readStageOutputs(projectRoot, stage);

	if (env.cli) return { region: env.cli, source: 'cli', outputs };
	if (env.env) return { region: env.env, source: 'env', outputs };

	if (outputs.status === 'found' && outputs.outputs) {
		const { region, reason } = regionFromOutputs(outputs.outputs);
		if (region) return { region, source: 'outputs', outputs };
		return { source: 'none', outputs, reason };
	}

	return { source: 'none', outputs, reason: outputs.reason };
}
