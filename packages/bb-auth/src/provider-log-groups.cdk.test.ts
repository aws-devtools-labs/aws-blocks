// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The deploy-time Lambdas `Auth` adds (the pool guard and the IdP registration,
 * each an onEvent function plus its `cr.Provider` framework function) log to log
 * groups the stack owns and deletes. A Lambda's role may not create a log group
 * of its own: the framework function flushes its last log lines a few seconds
 * after CloudFormation has deleted its group, and with `logs:CreateLogGroup`
 * that flush recreated the group outside the stack, so it outlived `destroy()`
 * (L80). Each role therefore carries an explicit deny, and each function reads
 * its group by reference, so the group exists before the first invocation.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { synthBlocksApp } from './test-support/blocks-app-synth.js';
import type { CfnTemplateJson } from './test-support/cdk-synth.js';
import { freshAppDir } from './test-support/guard-synth.js';

type Resource = CfnTemplateJson['Resources'][string];

/** The logical id a `{ Ref }` / `{ Fn::GetAtt: [id, …] }` points at, if any. */
function refOf(value: unknown): string | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.Ref === 'string') return v.Ref;
	const getAtt = v['Fn::GetAtt'];
	if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') return getAtt[0];
	return undefined;
}

/** Every statement of every inline policy attached to `roleId`. */
function statementsOfRole(template: CfnTemplateJson, roleId: string): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const r of Object.values(template.Resources) as Resource[]) {
		if (r.Type !== 'AWS::IAM::Policy') continue;
		const roles = (r.Properties?.Roles as unknown[] | undefined) ?? [];
		if (!roles.some((x) => refOf(x) === roleId)) continue;
		const doc = r.Properties?.PolicyDocument as { Statement?: Record<string, unknown>[] } | undefined;
		out.push(...(doc?.Statement ?? []));
	}
	return out;
}

function deniesLogGroupCreation(statements: Record<string, unknown>[]): boolean {
	return statements.some((s) => {
		const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
		return s.Effect === 'Deny' && actions.includes('logs:CreateLogGroup');
	});
}

/** The four owned log groups, by the construct ids that name them. */
const OWNED_GROUPS = [
	/^BlocksAuthPoolGuardLogs/,
	/^BlocksAuthPoolGuardProviderLogs/,
	/authidpregistrationlogs/,
	/authidpregistrationproviderlogs/,
];

describe("Auth's deploy-time Lambdas never create their own log groups (L80)", () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	test('every function logging to an owned group: explicit Deny logs:CreateLogGroup on its role', () => {
		const appDir = freshAppDir();
		dirs.push(appDir);
		const result = synthBlocksApp({
			appDir,
			build: `new Auth(stack, 'auth', { socialProviders: { google: { clientId: 'g', clientSecret: new AppSetting(stack, 'g-secret', { secret: true }) } } });`,
		});
		assert.ok(result.ok, result.stderr);
		const template = result.template;
		assert.ok(template);

		const groups = Object.entries(template.Resources).filter(
			([id, r]) => r.Type === 'AWS::Logs::LogGroup' && OWNED_GROUPS.some((re) => re.test(id)),
		);
		assert.strictEqual(groups.length, 4, `the four owned groups: ${groups.map(([id]) => id).join(', ')}`);

		for (const [groupId, group] of groups) {
			assert.strictEqual(group.DeletionPolicy, 'Delete', `${groupId} is deleted with the stack`);
			const fns: [string, Resource][] = Object.entries(template.Resources).filter(
				([, r]) =>
					r.Type === 'AWS::Lambda::Function' &&
					refOf((r.Properties?.LoggingConfig as Record<string, unknown> | undefined)?.LogGroup) === groupId,
			);
			assert.strictEqual(
				fns.length,
				1,
				`one function logs to ${groupId} (by reference, so the group exists first)`,
			);
			const [fnId, fn] = fns[0];
			const roleId = refOf(fn.Properties?.Role);
			assert.ok(roleId, `${fnId} has a role in this template`);
			assert.ok(
				deniesLogGroupCreation(statementsOfRole(template, roleId)),
				`${fnId}'s role ${roleId} must deny logs:CreateLogGroup`,
			);
		}
	});
});
