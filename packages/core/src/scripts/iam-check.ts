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
import { join, relative } from 'node:path';
import {
	type AppViolation,
	checkManagedPolicies,
	checkResourcePolicy,
	checkRole,
	checkStackName,
	checkStatement,
	checkApiChild,
	checkLayer,
	checkTransforms,
	isResourcePolicyType,
	type ResolvedStatement,
} from '../cdk/app-isolation-rules.js';
import { callsExecuteApi } from './iam-policies.js';

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
	/**
	 * Not violations: things a platform must act on for the app to work, e.g. the
	 * app calls its APIs through `execute-api` (Realtime, Agent streaming), which
	 * the shared boundary denies — it needs its own boundary (`--api-id`).
	 */
	notes: string[];
}

/** A usage problem (no assembly, no report): exit code 2, not a violation. */
export class IamCheckUsageError extends Error {}

interface Report {
	app?: { id?: string };
	violations?: AppViolation[];
	root?: string;
}

interface Artifact {
	type?: string;
	properties?: { templateFile?: string; stackName?: string; tags?: Record<string, string>; directoryName?: string };
	displayName?: string;
}

type Template = {
	Transform?: unknown;
	Parameters?: Record<string, unknown>;
	Resources?: Record<
		string,
		{ Type?: string; Properties?: Record<string, unknown>; Metadata?: Record<string, unknown> }
	>;
};

/** A stack template found in the assembly (top-level, in a nested assembly, or a nested stack). */
interface FoundStack {
	/** `<assembly dir relative to cdk.out>/<artifact id>`, or the nested-stack template's file name. */
	label: string;
	artifactId: string;
	stackName: string;
	/** Absolute path of the template file. */
	file: string;
	/** For a stack artifact: its manifest tags. A nested stack has no name of its own (`''`). */
	tags?: Record<string, string>;
}

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function readJson<T>(file: string): T {
	return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** Template rules: every role, every IAM policy, every managed-policy attachment, every resource policy. */
function checkTemplate(template: Template, id: string, stackId: string): AppViolation[] {
	const out: AppViolation[] = [...checkTransforms(template, stackId)];
	const parameters = new Set(Object.keys(template.Parameters ?? {}));
	for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
		const where = `${stackId}/${logicalId}`;
		const props = resource.Properties ?? {};
		const type = resource.Type ?? '';
		if (type === 'AWS::IAM::Role') {
			out.push(...checkRole(props, id, where, true, parameters));
		} else if (type === 'AWS::IAM::Policy' || type === 'AWS::IAM::ManagedPolicy' || type === 'AWS::IAM::RolePolicy') {
			const doc = props.PolicyDocument as { Statement?: ResolvedStatement[] } | undefined;
			for (const s of asArray(doc?.Statement)) out.push(...checkStatement(s, id, where, parameters));
		} else if (type === 'AWS::IAM::User' || type === 'AWS::IAM::Group') {
			out.push(...checkManagedPolicies(asArray(props.ManagedPolicyArns as unknown[] | undefined), where));
		} else if (type.startsWith('AWS::ApiGateway')) {
			out.push(...checkApiChild(type, props, id, where, parameters));
		} else if (type === 'AWS::Lambda::LayerVersion') {
			out.push(...checkLayer(props, id, where));
		} else if (isResourcePolicyType(type)) {
			out.push(...checkResourcePolicy(type, props, id, where, parameters));
		}
	}
	return out;
}

/**
 * Every stack template in the assembly at `dir`: its stack artifacts, those of
 * nested cloud assemblies (`cdk:cloud-assembly`, e.g. a `Stage`), and every
 * nested-stack template (`*.nested.template.json`). Anything it can't read is
 * reported, not skipped.
 */
function findStacks(root: string, dir: string, unreadable: IamCheckViolation[]): FoundStack[] {
	const manifestFile = join(dir, 'manifest.json');
	const rel = relative(root, dir) || '.';
	let manifest: { artifacts?: Record<string, Artifact> };
	try {
		manifest = readJson(manifestFile);
	} catch {
		unreadable.push({
			source: join(rel, 'manifest.json'),
			rule: 'unreadable-template',
			message: `Can't read ${join(rel, 'manifest.json')}, so its stacks can't be checked.`,
		});
		return [];
	}
	const found: FoundStack[] = [];
	for (const [artifactId, artifact] of Object.entries(manifest.artifacts ?? {})) {
		if (artifact.type === 'cdk:cloud-assembly' && artifact.properties?.directoryName) {
			found.push(...findStacks(root, join(dir, artifact.properties.directoryName), unreadable));
		} else if (artifact.type === 'aws:cloudformation:stack') {
			const templateFile = artifact.properties?.templateFile;
			const stackName = artifact.properties?.stackName ?? artifact.displayName ?? artifactId;
			if (!templateFile) {
				unreadable.push({
					source: join(rel, 'manifest.json'),
					rule: 'unreadable-template',
					message: `Stack ${artifactId} has no template file in the manifest, so it can't be checked.`,
				});
				continue;
			}
			found.push({
				label: rel === '.' ? artifactId : `${rel}/${artifactId}`,
				artifactId,
				stackName,
				file: join(dir, templateFile),
				tags: artifact.properties?.tags,
			});
		}
	}
	// Nested stacks: CDK writes their templates into the same directory as
	// `*.nested.template.json` (a file asset of the parent). Check every one,
	// whatever the parent's metadata says.
	const known = new Set(found.map((f) => f.file));
	for (const file of readdirSync(dir).filter((f) => f.endsWith('.nested.template.json'))) {
		const path = join(dir, file);
		if (known.has(path)) continue;
		const label = rel === '.' ? file : `${rel}/${file}`;
		found.push({ label, artifactId: label, stackName: '', file: path });
	}
	return found;
}

/**
 * Check the cloud assembly in `dir` (see the module doc). **Every** stack in the
 * assembly is checked, not only the ones the IAM report names: the app's own code
 * writes the report, and could add a stack it doesn't mention.
 *
 * @param dir the cloud assembly directory (`cdk.out`).
 * @param expectedApp the app id the pipeline expects (from its own registry, not
 *   the app's code). Without it, the id in the IAM report is used.
 * @throws IamCheckUsageError when `dir` has no manifest or no IAM report.
 */
export function checkCloudAssembly(dir: string, expectedApp?: string): IamCheckResult {
	if (!existsSync(join(dir, 'manifest.json'))) {
		throw new IamCheckUsageError(`${dir} is not a cloud assembly (no manifest.json). Run \`cdk synth\` first.`);
	}
	const reports = readdirSync(dir).filter((f) => f.endsWith('.blocks-iam.json'));
	if (reports.length === 0) {
		throw new IamCheckUsageError(
			`${dir} has no AWS Blocks IAM report (*.blocks-iam.json). Synthesize the app with AWS Blocks first.`,
		);
	}

	const violations: IamCheckViolation[] = [];
	const appIds = new Set<string>();
	const stacks = findStacks(dir, dir, violations);

	for (const file of reports) {
		const report = readJson<Report>(join(dir, file));
		const reported = report.app?.id;
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
		const id = expectedApp ?? reported;
		if (!id) continue;
		appIds.add(id);
		for (const v of report.violations ?? []) violations.push({ ...v, source: file });

		// A BlocksStack's own stack carries the app tag (an embedded backend's stack is the app's own).
		const stem = file.slice(0, -'.blocks-iam.json'.length);
		const own = stacks.find((s) => s.label === stem);
		if (own) {
			const tag = own.tags?.app;
			if (tag !== id) {
				violations.push({
					source: 'manifest.json',
					rule: 'stack-tag-mismatch',
					path: own.artifactId,
					message: `Stack ${own.artifactId} is tagged app=${JSON.stringify(tag ?? null)}; expected "${id}".`,
				});
			}
		}
	}
	if (appIds.size > 1) {
		violations.push({
			source: 'manifest.json',
			rule: 'app-id-mismatch',
			message: `The assembly holds more than one app (${[...appIds].join(', ')}); deploy one app per pipeline run.`,
		});
	}
	const id = expectedApp ?? [...appIds][0];
	const templates: string[] = [];
	const executeApi = new Set<string>();
	if (id) {
		for (const stack of stacks) {
			const source = relative(dir, stack.file);
			let template: Template;
			try {
				template = readJson(stack.file);
			} catch {
				violations.push({
					source,
					rule: 'unreadable-template',
					message: `Can't read the template of ${stack.label} (${source}), so it can't be checked.`,
				});
				continue;
			}
			templates.push(source);
			for (const use of callsExecuteApi([template])) executeApi.add(`${use} in ${stack.label}`);
			for (const v of checkTemplate(template, id, stack.label)) violations.push({ ...v, source });
			// Every stack is named after the app — including Hosting's us-east-1 edge
			// stack, which AWS Blocks names `<id>-edge` when `defaults.app` is set.
			if (stack.stackName !== '') {
				for (const v of checkStackName(stack.stackName, id)) violations.push({ ...v, source: 'manifest.json' });
			}
		}
	}

	// The template's tag check and the report's can find the same untagged role;
	// keep one line per (source, rule, message).
	const seen = new Set<string>();
	const unique = violations.filter((v) => {
		const key = `${v.source}|${v.rule}|${v.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const notes =
		executeApi.size > 0
			? [
					`The app calls its APIs through execute-api (${[...executeApi].sort().join('; ')}). The shared boundary ` +
						'denies execute-api, so Realtime and Agent streaming fail under it: give this app its own boundary ' +
						'(blocks-iam-policies --api-id).',
				]
			: [];
	return { appIds: [...appIds], reports, templates, violations: unique, notes };
}
