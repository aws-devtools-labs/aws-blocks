#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI for `iam-policies.ts`. Exposed as the `blocks-iam-policies` bin entry on
 * `@aws-blocks/core`. **EXPERIMENTAL**: review the output and test it on a
 * deployed app before relying on it.
 *
 * Usage:
 *   blocks-iam-policies [cdk.out] [--out <dir>] [--boundary-name <name>]
 *                       [--app <id> --account <12 digits> [--api-id <api id>]...] [--partition <p>]
 *
 * Always writes `<out>/boundary.json`, the permissions boundary shared by every
 * app in the account. With `--app` and `--account`, also writes
 * `<out>/execution-<id>.json`, the app's CloudFormation execution policy, built
 * from the resource types in the synthesized templates in `cdk.out` (it lists
 * any resource type it has no scoped rule for), and `<out>/deploy-guard-<id>.json`,
 * the policy to attach to the app's CDK bootstrap deploy role. With
 * `--api-id` (once per API id of the app's own, deployed APIs, e.g. its REST API
 * and a Realtime WebSocket API), also writes `<out>/boundary-<id>.json`, a boundary
 * for that one app that allows `execute-api` on exactly those APIs, and pins the
 * execution policy's API Gateway management to them; the execution policy then
 * requires that boundary. Without `--api-id`, it warns when the app calls its
 * APIs through `execute-api` (a WebSocket API, or a role granted an
 * `execute-api:` action), which the shared boundary denies.
 *
 * The execution policy is split into parts of at most 5,120 characters (IAM's
 * limit is 6,144), so each part has room for statements added by hand. The CLI
 * prints the types it grants as accepted exceptions (no app scope possible) and
 * the types it has no scoped rule for.
 *
 * Exit codes: 0 written · 2 usage error.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appIdProblem } from '../cdk/app-isolation-rules.js';
import {
	callsExecuteApi,
	EXECUTION_POLICY_SPLIT_CHARS,
	generateBoundaryPolicy,
	generateDeployGuardPolicy,
	generateExecutionPolicy,
	type IamPolicyOptions,
	MANAGED_POLICY_MAX_CHARS,
	type PolicyDocument,
	policySize,
	resourceTypesOf,
	splitPolicy,
	UNSCOPED_REASONS,
} from './iam-policies.js';

function usage(message?: string): never {
	if (message) process.stderr.write(`blocks-iam-policies: ${message}\n`);
	process.stderr.write(
		'Usage: blocks-iam-policies [cdk.out] [--out <dir>] [--boundary-name <name>] ' +
			'[--app <id> --account <12 digits> [--api-id <api id>]...] [--partition <p>]\n',
	);
	process.exit(2);
}

const args = process.argv.slice(2);
let assembly = 'cdk.out';
let out = 'iam-policies';
const options: IamPolicyOptions = {};
const take = (i: number, flag: string) => {
	const value = args[i];
	if (!value) usage(`${flag} needs a value.`);
	return value;
};
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === '--out') out = take(++i, arg);
	else if (arg === '--boundary-name') options.boundaryName = take(++i, arg);
	else if (arg === '--app') options.appId = take(++i, arg);
	else if (arg === '--account') options.account = take(++i, arg);
	else if (arg === '--partition') options.partition = take(++i, arg);
	else if (arg === '--api-id') {
		// One flag for both uses of the app's own API ids: the per-app boundary's
		// execute-api access, and pinning the execution policy's API Gateway rule.
		const api = take(++i, arg);
		options.executeApiIds = [...(options.executeApiIds ?? []), api];
		options.apiIds = [...(options.apiIds ?? []), api];
	}
	else if (arg === '--help' || arg === '-h') usage();
	else if (arg.startsWith('-')) usage(`unknown option ${arg}.`);
	else assembly = arg;
}

if (options.appId !== undefined) {
	// Before writing anything: a reserved id's `<id>-…` names cover other apps' resources.
	const problem = appIdProblem(options.appId);
	if (problem) usage(`--app: ${problem}`);
}

const write = (file: string, doc: PolicyDocument) => {
	writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
	const size = policySize(doc);
	const note = size > MANAGED_POLICY_MAX_CHARS ? ` — over IAM's ${MANAGED_POLICY_MAX_CHARS}; split it into two policies` : '';
	process.stdout.write(`  ${file} (${size} characters${note})\n`);
};

mkdirSync(resolve(out), { recursive: true });
process.stdout.write('blocks-iam-policies (EXPERIMENTAL) wrote:\n');
const executeApiIds = options.executeApiIds ?? [];
write(join(out, 'boundary.json'), generateBoundaryPolicy({ ...options, executeApiIds: [] }));
if (executeApiIds.length > 0) {
	if (!options.appId) usage('--api-id needs --app: it makes a boundary for that one app.');
	// A per-app boundary: the shared statements plus `execute-api` on this app's own APIs.
	options.boundaryName = `${options.boundaryName ?? 'apps-boundary'}-${options.appId}`;
	write(join(out, `boundary-${options.appId}.json`), generateBoundaryPolicy(options));
	process.stdout.write(
		`  → create it as "${options.boundaryName}" and set defaults.permissionsBoundary to it for this app; ` +
			'the execution policy below requires it.\n',
	);
}

if (options.appId || options.account) {
	let templates: { Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }> }[];
	try {
		templates = readdirSync(resolve(assembly))
			.filter((f) => f.endsWith('.template.json'))
			.map((f) => JSON.parse(readFileSync(join(resolve(assembly), f), 'utf8')));
	} catch {
		usage(`can't read templates in ${assembly}. Run \`cdk synth\` first.`);
	}
	if (templates.length === 0) usage(`${assembly} has no templates. Run \`cdk synth\` first.`);
	let result: ReturnType<typeof generateExecutionPolicy>;
	try {
		result = generateExecutionPolicy(resourceTypesOf(templates), options);
	} catch (error) {
		usage(error instanceof Error ? error.message : String(error));
	}
	// One file per managed policy. IAM caps each at 6,144 characters; split lower,
	// so every part has room for statements the platform adds by hand.
	const parts = splitPolicy(result.document, EXECUTION_POLICY_SPLIT_CHARS);
	for (const [i, part] of parts.entries()) {
		write(join(out, `execution-${options.appId}${i === 0 ? '' : `-${i + 1}`}.json`), part);
	}
	if (parts.length > 1) {
		process.stdout.write(
			`  → ${parts.length} execution policies: pass all of them, comma-separated, to cdk bootstrap --cloudformation-execution-policies.\n`,
		);
	}
	write(join(out, `deploy-guard-${options.appId}.json`), generateDeployGuardPolicy(options));
	if (result.accepted.length > 0) {
		process.stdout.write(
			"\nAccepted exceptions — granted without an app scope, because the service can't scope them by name or tag " +
				'(statement "CloudFrontUnscopableConfig"; see the README\'s Limits):\n' +
				result.accepted.map((t) => `  • ${t}\n`).join(''),
		);
	}
	if (result.tagScoped.length > 0) {
		process.stdout.write(
			`\nManaged only once tagged app=${options.appId} — existing resources of these types must already carry the tag ` +
				"(an app adopting defaults.app: an admin tags them once before the first deploy; see the core README's " +
				'"Adopting defaults.app in an existing app"):\n' +
				result.tagScoped.map((t) => `  • ${t}\n`).join(''),
		);
	}
	if (result.unscoped.length > 0) {
		process.stdout.write(
			`\nNo scoped rule for these resource types — add statements for them to execution-${options.appId}.json by hand:\n` +
				result.unscoped.map((t) => `  • ${t}${UNSCOPED_REASONS[t] ? ` — ${UNSCOPED_REASONS[t]}` : ''}\n`).join(''),
		);
	}
	const executeApi = callsExecuteApi(templates);
	if (executeApi.length > 0 && executeApiIds.length === 0) {
		process.stdout.write(
			'\n!!! WARNING: this app calls its APIs through execute-api, which the shared boundary denies:\n' +
				executeApi.map((w) => `  • ${w}\n`).join('') +
				'  Under boundary.json, Realtime publish/subscribe and Agent streaming fail at runtime (AccessDenied on\n' +
				'  execute-api:ManageConnections). Give this app its own boundary, ' +
				`"${options.boundaryName ?? 'apps-boundary'}-${options.appId}", from its first deploy, and once its APIs exist\n` +
				'  regenerate with --api-id <api id> (once per API).\n',
		);
	}
}
