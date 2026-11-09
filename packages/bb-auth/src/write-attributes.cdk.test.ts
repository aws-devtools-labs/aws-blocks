// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The native app client's `WriteAttributes` (`mapClientWriteAttributes`):
 * every standard attribute but the verified flags, plus only the custom
 * attributes declared `userWritable: true`. The runtime applies the same rule
 * before any Cognito call (`engines/attribute-write-rules.ts`), so a write the
 * client may not make is refused on both sides.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { CfnTemplateJson } from './test-support/cdk-synth.js';
import { synthIdentity } from './test-support/identity.js';

/** Cognito's standard attributes as `WriteAttributes` names them: no `sub`, no verified flag. */
const STANDARD = [
	'address',
	'birthdate',
	'email',
	'family_name',
	'gender',
	'given_name',
	'locale',
	'middle_name',
	'name',
	'nickname',
	'phone_number',
	'picture',
	'preferred_username',
	'profile',
	'updated_at',
	'website',
	'zoneinfo',
];

/** The `WriteAttributes` of every `AWS::Cognito::UserPoolClient`, by logical id. */
function writeAttributes(template: CfnTemplateJson): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [id, resource] of Object.entries(template.Resources)) {
		if (resource.Type === 'AWS::Cognito::UserPoolClient') out[id] = resource.Properties?.WriteAttributes;
	}
	return out;
}

/** The single native client's `WriteAttributes`. */
function nativeClientWrites(construct: string): unknown {
	const clients = Object.values(writeAttributes(synthIdentity(construct).template));
	assert.strictEqual(clients.length, 1, 'one app client');
	return clients[0];
}

describe('Auth (CDK) — the app client writes only what end users may write', () => {
	test('no custom attributes: the standard attributes, without the verified flags', () => {
		assert.deepStrictEqual(nativeClientWrites("new Auth(stack, 'auth')"), STANDARD);
	});

	test('custom attributes: only the `userWritable` ones are listed', () => {
		const writes = nativeClientWrites(
			"new Auth(stack, 'auth', { users: { attributes: [{ name: 'team', userWritable: true }, { name: 'role' }, { name: 'tier', mutable: false, userWritable: false }] } })",
		);
		assert.deepStrictEqual(writes, [...STANDARD, 'custom:team'].sort());
	});

	test('the user pool schema still declares every custom attribute', () => {
		const { template } = synthIdentity(
			"new Auth(stack, 'auth', { users: { attributes: [{ name: 'team', userWritable: true }, { name: 'role' }] } })",
		);
		const pool = Object.values(template.Resources).find((r) => r.Type === 'AWS::Cognito::UserPool');
		const schema = pool?.Properties?.Schema;
		assert.ok(Array.isArray(schema));
		const names = schema.map((a: unknown) => String(Reflect.get(Object(a), 'Name'))).sort();
		assert.deepStrictEqual(names, ['role', 'team']);
		// `mutable` keeps its default (true): an existing attribute's mutability cannot change.
		for (const attr of schema) assert.strictEqual(Reflect.get(Object(attr), 'Mutable'), true);
	});

	test('a wrapped pool (`Auth.fromExisting`): its new client lists only the declared `userWritable` attributes', () => {
		const writes = nativeClientWrites(
			"new Auth(stack, 'auth', { userPool: Auth.fromExisting('us-east-1_Existing'), users: { attributes: [{ name: 'dept', userWritable: true }, { name: 'role' }] } })",
		);
		assert.deepStrictEqual(writes, [...STANDARD, 'custom:dept'].sort());
	});

	test('the hosted-UI client keeps Cognito’s default write set (mapped IdP attributes are written through it)', () => {
		const { template } = synthIdentity(
			"new Auth(stack, 'auth', { providers: { google: { type: 'google', clientId: 'g', clientSecret: new AppSetting(stack, 'google-secret', { secret: true }) } }, users: { attributes: [{ name: 'role' }] } })",
		);
		const all = writeAttributes(template);
		assert.strictEqual(Object.keys(all).length, 2, 'native and hosted-UI clients');
		const values = Object.values(all);
		assert.ok(values.includes(undefined), 'the hosted-UI client sets no WriteAttributes');
		assert.ok(
			values.some((v) => JSON.stringify(v) === JSON.stringify(STANDARD)),
			'the native client lists the standard set',
		);
	});
});
