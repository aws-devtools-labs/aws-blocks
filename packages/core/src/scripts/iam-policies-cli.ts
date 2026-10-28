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
 *                       [--app <id> --account <12 digits>] [--partition <p>]
 *
 * Always writes `<out>/boundary.json`, the permissions boundary shared by every
 * app in the account. With `--app` and `--account`, also writes
 * `<out>/execution-<id>.json`, the app's CloudFormation execution policy, built
 * from the resource types in the synthesized templates in `cdk.out` (it lists
 * any resource type it has no scoped rule for), and `<out>/deploy-guard-<id>.json`,
 * the policy to attach to the app's CDK bootstrap deploy role.
 *
 * Exit codes: 0 written · 2 usage error.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	generateBoundaryPolicy,
	generateDeployGuardPolicy,
	generateExecutionPolicy,
	type IamPolicyOptions,
	MANAGED_POLICY_MAX_CHARS,
	type PolicyDocument,
	policySize,
	resourceTypesOf,
} from './iam-policies.js';

function usage(message?: string): never {
	if (message) process.stderr.write(`blocks-iam-policies: ${message}\n`);
	process.stderr.write(
		'Usage: blocks-iam-policies [cdk.out] [--out <dir>] [--boundary-name <name>] ' +
			'[--app <id> --account <12 digits>] [--partition <p>]\n',
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
	else if (arg === '--help' || arg === '-h') usage();
	else if (arg.startsWith('-')) usage(`unknown option ${arg}.`);
	else assembly = arg;
}

const write = (file: string, doc: PolicyDocument) => {
	writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
	const size = policySize(doc);
	const note = size > MANAGED_POLICY_MAX_CHARS ? ` — over IAM's ${MANAGED_POLICY_MAX_CHARS}; split it into two policies` : '';
	process.stdout.write(`  ${file} (${size} characters${note})\n`);
};

mkdirSync(resolve(out), { recursive: true });
process.stdout.write('blocks-iam-policies (EXPERIMENTAL) wrote:\n');
write(join(out, 'boundary.json'), generateBoundaryPolicy(options));

if (options.appId || options.account) {
	let templates: { Resources?: Record<string, { Type?: string }> }[];
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
	write(join(out, `execution-${options.appId}.json`), result.document);
	write(join(out, `deploy-guard-${options.appId}.json`), generateDeployGuardPolicy(options));
	if (result.unscoped.length > 0) {
		process.stdout.write(
			`\nNo scoped rule for these resource types — add statements for them to execution-${options.appId}.json by hand:\n` +
				result.unscoped.map((t) => `  • ${t}\n`).join(''),
		);
	}
}
