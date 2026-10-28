// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `blocks-iam-check`: the pipeline check for an app on a shared app platform
 * (`defaults.app`). It reads a synthesized cloud assembly (`cdk.out`) and fails
 * when the app reaches outside itself.
 *
 * It checks two things, so a malicious app can't pass by faking one:
 * 1. the IAM report each AWS Blocks root writes at synth
 *    (`<stack>.blocks-iam.json`) — its `violations`, and that its `app.id` is the
 *    id the pipeline expects;
 * 2. the CloudFormation templates themselves — what CloudFormation will actually
 *    deploy — with the same rules: every role bounded and tagged as the app, no
 *    grant on another app's resources, no wildcard data grant, no broad AWS
 *    managed policy, the stack named and tagged as the app.
 *
 * It's fast feedback with a clear message, not the boundary: the boundary is IAM
 * (the permissions boundary and the per-app execution role).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	type AppViolation,
	checkManagedPolicies,
	checkRole,
	checkStackName,
	checkStatement,
	type ResolvedStatement,
} from '../cdk/app-isolation-rules.js';

/** A violation with where it was found: the report file, or the template. */
export interface IamCheckViolation extends AppViolation {
	source: string;
}

/** The outcome of {@link checkCloudAssembly}. */
export interface IamCheckResult {
	/** The app ids found in the reports (or the expected one). */
	appIds: string[];
	/** The report files read. */
	reports: string[];
	/** The templates checked. */
	templates: string[];
	violations: IamCheckViolation[];
}

/** A usage problem (no assembly, no report): exit code 2, not a violation. */
export class IamCheckUsageError extends Error {}

interface Report {
	app?: { id?: string };
	violations?: AppViolation[];
	roles?: { stack?: string }[];
	root?: string;
}

interface StackArtifact {
	type?: string;
	properties?: { templateFile?: string; stackName?: string; tags?: Record<string, string> };
	displayName?: string;
}

type Template = { Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }> };

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function readJson<T>(file: string): T {
	return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** Template rules: every role, every IAM policy, every managed-policy attachment. */
function checkTemplate(template: Template, id: string, stackId: string): AppViolation[] {
	const out: AppViolation[] = [];
	for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
		const where = `${stackId}/${logicalId}`;
		const props = resource.Properties ?? {};
		if (resource.Type === 'AWS::IAM::Role') {
			out.push(...checkRole(props, id, where, true));
		} else if (resource.Type === 'AWS::IAM::Policy' || resource.Type === 'AWS::IAM::ManagedPolicy') {
			const doc = props.PolicyDocument as { Statement?: ResolvedStatement[] } | undefined;
			for (const s of asArray(doc?.Statement)) out.push(...checkStatement(s, id, where));
		} else if (resource.Type === 'AWS::IAM::RolePolicy') {
			const doc = props.PolicyDocument as { Statement?: ResolvedStatement[] } | undefined;
			for (const s of asArray(doc?.Statement)) out.push(...checkStatement(s, id, where));
		} else if (resource.Type === 'AWS::IAM::User' || resource.Type === 'AWS::IAM::Group') {
			out.push(...checkManagedPolicies(asArray(props.ManagedPolicyArns as unknown[] | undefined), where));
		}
	}
	return out;
}

/**
 * Check the cloud assembly in `dir` (see the module doc).
 *
 * @param dir the cloud assembly directory (`cdk.out`).
 * @param expectedApp the app id the pipeline expects (from its own registry, not
 *   the app's code). Without it, each report's own `app.id` is used.
 * @throws IamCheckUsageError when `dir` has no manifest or no IAM report.
 */
export function checkCloudAssembly(dir: string, expectedApp?: string): IamCheckResult {
	const manifestFile = join(dir, 'manifest.json');
	if (!existsSync(manifestFile)) {
		throw new IamCheckUsageError(`${dir} is not a cloud assembly (no manifest.json). Run \`cdk synth\` first.`);
	}
	const manifest = readJson<{ artifacts?: Record<string, StackArtifact> }>(manifestFile);
	const stacks = Object.entries(manifest.artifacts ?? {}).filter(([, a]) => a.type === 'aws:cloudformation:stack');
	const reports = readdirSync(dir).filter((f) => f.endsWith('.blocks-iam.json'));
	if (reports.length === 0) {
		throw new IamCheckUsageError(
			`${dir} has no AWS Blocks IAM report (*.blocks-iam.json). Synthesize the app with AWS Blocks first.`,
		);
	}

	const violations: IamCheckViolation[] = [];
	const appIds = new Set<string>();
	const checkedStacks = new Map<string, string>();

	for (const file of reports) {
		const report = readJson<Report>(join(dir, file));
		const reported = report.app?.id;
		const id = expectedApp ?? reported;
		if (!reported) {
			violations.push({
				source: file,
				rule: 'app-id-mismatch',
				message: `${file} has no app identity. Set defaults.app on the app's BlocksStack/BlocksBackend.`,
			});
		} else if (expectedApp && reported !== expectedApp) {
			violations.push({
				source: file,
				rule: 'app-id-mismatch',
				message: `${file} says the app is "${reported}", but the pipeline expects "${expectedApp}".`,
			});
		}
		if (!id) continue;
		appIds.add(id);
		for (const v of report.violations ?? []) violations.push({ ...v, source: file });

		// The stacks this report's roles live in, plus the report's own stack.
		const stem = file.slice(0, -'.blocks-iam.json'.length);
		const owned = new Set(asArray(report.roles).map((r) => r.stack).filter((s): s is string => !!s));
		const own = stacks.find(([artifactId]) => artifactId === stem || stem.startsWith(`${artifactId}.`));
		if (own) owned.add(own[0]);
		for (const artifactId of owned) checkedStacks.set(artifactId, id);

		// A BlocksStack's own stack carries the app tag (an embedded backend's stack is the app's own).
		if (own && own[0] === stem) {
			const tag = own[1].properties?.tags?.app;
			if (tag !== id) {
				violations.push({
					source: 'manifest.json',
					rule: 'stack-tag-mismatch',
					path: own[0],
					message: `Stack ${own[0]} is tagged app=${JSON.stringify(tag ?? null)}; expected "${id}".`,
				});
			}
		}
	}

	const templates: string[] = [];
	for (const [artifactId, id] of checkedStacks) {
		const artifact = stacks.find(([a]) => a === artifactId)?.[1];
		const templateFile = artifact?.properties?.templateFile;
		if (!templateFile) continue;
		templates.push(templateFile);
		const template = readJson<Template>(join(dir, templateFile));
		for (const v of checkTemplate(template, id, artifactId)) violations.push({ ...v, source: templateFile });
		const stackName = artifact.properties?.stackName ?? artifact.displayName ?? artifactId;
		// Helper stacks AWS Blocks adds (us-east-1 edge / monitoring) are named by CDK, not the app.
		const isHelper = /^edge-lambda-stack-|-CfMonitoring-/.test(stackName);
		if (!isHelper) {
			for (const v of checkStackName(stackName, id)) violations.push({ ...v, source: 'manifest.json' });
		}
	}

	// The template's tag check and the report's can find the same untagged role;
	// keep one line per (rule, message).
	const seen = new Set<string>();
	const unique = violations.filter((v) => {
		const key = `${v.source}|${v.rule}|${v.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return { appIds: [...appIds], reports, templates, violations: unique };
}
