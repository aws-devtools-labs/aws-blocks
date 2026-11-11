// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { forEachBlocksRole } from './blocks-roles.js';

/**
 * Service principals whose trust statements need no source condition: Lambda
 * execution roles (including the Lambda@Edge replicator principal CDK adds to an
 * `experimental.EdgeFunction` role beside `lambda.amazonaws.com`).
 */
const UNCONDITIONED_SERVICES: ReadonlySet<string> = new Set(['lambda.amazonaws.com', 'edgelambda.amazonaws.com']);

/** Condition keys that scope a service-principal trust to this account's resources (compared case-insensitively). */
const SOURCE_KEYS: ReadonlySet<string> = new Set(['aws:sourceaccount', 'aws:sourcearn']);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

/** The role's rendered `AssumeRolePolicyDocument` (property overrides included), or `undefined`. */
function trustDocument(role: cdk.CfnResource): unknown {
	const rendered = cdk.Stack.of(role).resolve(role._toCloudFormation());
	if (!isObject(rendered) || !isObject(rendered.Resources)) return undefined;
	const resource = Object.values(rendered.Resources)[0];
	if (!isObject(resource) || !isObject(resource.Properties)) return undefined;
	return resource.Properties.AssumeRolePolicyDocument;
}

function hasSourceCondition(condition: unknown): boolean {
	if (!isObject(condition)) return false;
	return Object.values(condition).some(
		(block) => isObject(block) && Object.keys(block).some((key) => SOURCE_KEYS.has(key.toLowerCase())),
	);
}

function describe(service: unknown): string {
	return typeof service === 'string' ? service : JSON.stringify(service);
}

/**
 * The service principals in `role`'s trust policy that `Allow` an assume-role
 * action with neither an `aws:SourceAccount` nor an `aws:SourceArn` condition,
 * other than the Lambda execution principals ({@link UNCONDITIONED_SERVICES}).
 *
 * @internal
 */
export function unconditionedServicePrincipals(role: cdk.CfnResource): string[] {
	const doc = trustDocument(role);
	if (!isObject(doc)) return [];
	const found: string[] = [];
	for (const statement of asArray(doc.Statement)) {
		if (!isObject(statement) || statement.Effect !== 'Allow' || !isObject(statement.Principal)) continue;
		if (hasSourceCondition(statement.Condition)) continue;
		for (const service of asArray(statement.Principal.Service)) {
			if (typeof service === 'string' && UNCONDITIONED_SERVICES.has(service)) continue;
			const name = describe(service);
			if (!found.includes(name)) found.push(name);
		}
	}
	return found;
}

/**
 * Fail synth when an IAM role AWS Blocks creates for `root` (the set
 * {@link forEachBlocksRole} visits) trusts a service principal without an
 * `aws:SourceAccount` or `aws:SourceArn` condition. Lambda execution roles are
 * accepted as they are ({@link UNCONDITIONED_SERVICES}).
 *
 * Checks role trust policies only — not resource policies or KMS grants. Runs
 * as a construct validation, so it sees each trust policy after every block has
 * added its statements. The cross-region reference providers CDK adds while
 * preparing the app are reached after validation and are not checked; they are
 * Lambda execution roles.
 *
 * @internal
 */
export function addServicePrincipalTrustCheck(root: Construct): void {
	forEachBlocksRole(root, (role) => {
		role.node.addValidation({
			validate: () =>
				unconditionedServicePrincipals(role).map(
					(service) =>
						`IAM role ${role.node.path} trusts the service principal ${service} without an ` +
						'aws:SourceAccount or aws:SourceArn condition. Add aws:SourceAccount (StringEquals, the stack account) ' +
						'and aws:SourceArn (ArnLike, an ARN pattern for the resources of that service) to its trust statement.',
				),
		});
	});
}
