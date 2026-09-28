// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import {
	config,
	configEnvVarName,
	DEFAULT_CONFIG_PARAMETER_PREFIX,
	DEFAULT_SECRET_PARAMETER_PREFIX,
	decodeManagedValue,
	encodeManagedValue,
	fallbackEnvVarName,
	isConfig,
	isManagedValue,
	isManagedValueJSON,
	isSecret,
	MANAGED_BRAND,
	MANAGED_VALUE_JSON_TAG,
	MANAGED_VALUE_JSON_VERSION,
	ManagedValueCodecError,
	managedValueReplacer,
	managedValueReviver,
	parameterName,
	secret,
	secretEnvVarName,
	secretStoreLocator,
	storeForKind,
} from './secret.js';

/** A minimal, valid Standard Schema used to declare a schema-bearing marker in tests. */
const passthroughSchema = {
	'~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => ({ value }) },
};

void describe('secret() / config() markers', () => {
	void it('secret() → branded marker, kind "secret"', () => {
		const s = secret('STRIPE_KEY');
		assert.strictEqual(s.key, 'STRIPE_KEY');
		assert.strictEqual(s.kind, 'secret');
		assert.strictEqual(s[MANAGED_BRAND], true);
	});

	void it('config() → branded marker, kind "config"', () => {
		const c = config('FEATURE_FLAGS');
		assert.strictEqual(c.key, 'FEATURE_FLAGS');
		assert.strictEqual(c.kind, 'config');
		assert.strictEqual(c[MANAGED_BRAND], true);
	});

	void it('rejects invalid keys (both functions)', () => {
		for (const fn of [secret, config]) {
			assert.throws(() => fn(''), /invalid key/);
			assert.throws(() => fn('1ABC'), /invalid key/);
			assert.throws(() => fn('a-b'), /invalid key/);
			assert.throws(() => fn('a/b'), /invalid key/);
		}
		assert.ok(secret('_x'));
		assert.ok(config('a1_b2'));
	});
});

void describe('type guards', () => {
	void it('isSecret / isConfig / isManagedValue', () => {
		assert.ok(isSecret(secret('K')));
		assert.ok(!isSecret(config('K')));
		assert.ok(isConfig(config('K')));
		assert.ok(!isConfig(secret('K')));
		assert.ok(isManagedValue(secret('K')));
		assert.ok(isManagedValue(config('K')));
		assert.ok(!isManagedValue({ key: 'K', kind: 'secret' })); // look-alike, no brand
		assert.ok(!isManagedValue(null));
		assert.ok(!isManagedValue('K'));
	});
});

void describe('storeForKind — kind → store (single source of truth)', () => {
	void it('secret → Secrets Manager, config → SSM', () => {
		assert.strictEqual(storeForKind('secret'), 'secrets-manager');
		assert.strictEqual(storeForKind('config'), 'ssm');
	});
});

void describe('paths, prefixes, env naming', () => {
	void it('separate default prefixes per kind', () => {
		assert.strictEqual(DEFAULT_SECRET_PARAMETER_PREFIX, '/hosting/secrets');
		assert.strictEqual(DEFAULT_CONFIG_PARAMETER_PREFIX, '/hosting/config');
		assert.strictEqual(parameterName('K', '/blocks/secrets'), '/blocks/secrets/K');
	});

	void it('secret locator (Secrets Manager) is slash-free; config locator (SSM) keeps the slash', () => {
		assert.strictEqual(
			secretStoreLocator('STRIPE_KEY', { prefix: '/blocks/secrets', store: 'secrets-manager' }),
			'blocks/secrets/STRIPE_KEY',
		);
		assert.strictEqual(
			secretStoreLocator('FLAGS', { prefix: '/blocks/config', store: 'ssm' }),
			'/blocks/config/FLAGS',
		);
	});

	void it('stage inserts a segment between prefix and key', () => {
		assert.strictEqual(
			secretStoreLocator('K', { prefix: '/p', store: 'secrets-manager', stage: 'prod' }),
			'p/prod/K',
		);
		assert.strictEqual(secretStoreLocator('K', { prefix: '/p', store: 'ssm', stage: 'beta' }), '/p/beta/K');
	});

	void it('separate env var prefixes per kind + fallback', () => {
		assert.strictEqual(secretEnvVarName('K'), 'HOSTING_SECRET_PARAM_K');
		assert.strictEqual(configEnvVarName('K'), 'HOSTING_CONFIG_PARAM_K');
		assert.strictEqual(fallbackEnvVarName(secretEnvVarName('K')), 'HOSTING_SECRET_PARAM_K_FALLBACK');
	});
});

void describe('managed value JSON codec', () => {
	void it('a raw JSON round-trip loses the brand (motivates the codec)', () => {
		const roundTripped = JSON.parse(JSON.stringify(secret('TOKEN')));
		assert.strictEqual(isManagedValue(roundTripped), false);
	});

	void it('encode → decode restores a branded secret marker', () => {
		const restored = decodeManagedValue(encodeManagedValue(secret('TOKEN')));
		assert.ok(isSecret(restored));
		assert.strictEqual(restored.key, 'TOKEN');
		assert.strictEqual(restored.kind, 'secret');
	});

	void it('encode → decode restores a branded config marker', () => {
		const restored = decodeManagedValue(encodeManagedValue(config('DOMAIN')));
		assert.ok(isConfig(restored));
		assert.strictEqual(restored.key, 'DOMAIN');
	});

	void it('encoded form is tagged, versioned, and JSON-safe', () => {
		const encoded = encodeManagedValue(config('DOMAIN'));
		assert.deepStrictEqual(encoded, {
			[MANAGED_VALUE_JSON_TAG]: { v: MANAGED_VALUE_JSON_VERSION, kind: 'config', key: 'DOMAIN' },
		});
		assert.ok(isManagedValueJSON(JSON.parse(JSON.stringify(encoded))));
	});

	void it('replacer + reviver survive a full JSON.stringify/parse round-trip in a nested object', () => {
		const original = {
			domain: config('DOMAIN'),
			apiKey: secret('API_KEY'),
			plain: 'literal',
			nested: { flags: config('FLAGS') },
		};
		const wire = JSON.stringify(original, managedValueReplacer);
		const restored = JSON.parse(wire, managedValueReviver) as typeof original;

		assert.ok(isConfig(restored.domain) && restored.domain.key === 'DOMAIN');
		assert.ok(isSecret(restored.apiKey) && restored.apiKey.key === 'API_KEY');
		assert.strictEqual(restored.plain, 'literal');
		assert.ok(isConfig(restored.nested.flags) && restored.nested.flags.key === 'FLAGS');
	});

	void it('reviver leaves non-marker values untouched', () => {
		const restored = JSON.parse(JSON.stringify({ a: 1, b: 'x', c: [1, 2] }), managedValueReviver);
		assert.deepStrictEqual(restored, { a: 1, b: 'x', c: [1, 2] });
	});

	void it('isManagedValueJSON rejects malformed shapes', () => {
		const V = MANAGED_VALUE_JSON_VERSION;
		assert.strictEqual(isManagedValueJSON({ [MANAGED_VALUE_JSON_TAG]: { v: V, kind: 'nope', key: 'K' } }), false);
		assert.strictEqual(isManagedValueJSON({ [MANAGED_VALUE_JSON_TAG]: { v: V, kind: 'secret' } }), false);
		assert.strictEqual(
			isManagedValueJSON({ [MANAGED_VALUE_JSON_TAG]: { v: V, kind: 'secret', key: 'a-b' } }),
			false,
		); // bad key syntax
		assert.strictEqual(isManagedValueJSON({ [MANAGED_VALUE_JSON_TAG]: { kind: 'secret', key: 'K' } }), false); // missing version
		assert.strictEqual(isManagedValueJSON({ kind: 'secret', key: 'K' }), false);
		assert.strictEqual(isManagedValueJSON(null), false);
	});
});

void describe('managed value JSON codec — wire versioning (B2)', () => {
	void it('exports a numeric protocol version and stamps it into encoded values', () => {
		assert.strictEqual(typeof MANAGED_VALUE_JSON_VERSION, 'number');
		const encoded = encodeManagedValue(secret('TOKEN'));
		assert.strictEqual(encoded[MANAGED_VALUE_JSON_TAG].v, MANAGED_VALUE_JSON_VERSION);
	});

	void it('rejects an unknown future wire version rather than silently reinterpreting it', () => {
		const future = { [MANAGED_VALUE_JSON_TAG]: { v: MANAGED_VALUE_JSON_VERSION + 1, kind: 'secret', key: 'K' } };
		assert.strictEqual(isManagedValueJSON(future), false);
		assert.throws(() => decodeManagedValue(future), ManagedValueCodecError);
		assert.throws(() => decodeManagedValue(future), /unsupported wire version/);
	});

	void it('rejects an unknown kind rather than aliasing it to config', () => {
		const bad = { [MANAGED_VALUE_JSON_TAG]: { v: MANAGED_VALUE_JSON_VERSION, kind: 'future-kind', key: 'K' } };
		assert.strictEqual(isManagedValueJSON(bad), false);
		assert.throws(() => decodeManagedValue(bad), /unknown kind/);
	});

	void it('an unknown future wire version passes through the reviver untouched (no throw)', () => {
		const wire = JSON.stringify({
			later: { [MANAGED_VALUE_JSON_TAG]: { v: MANAGED_VALUE_JSON_VERSION + 1, kind: 'secret', key: 'K' } },
		});
		const restored = JSON.parse(wire, managedValueReviver) as { later: unknown };
		assert.strictEqual(isManagedValue(restored.later), false);
		assert.deepStrictEqual(restored.later, {
			[MANAGED_VALUE_JSON_TAG]: { v: MANAGED_VALUE_JSON_VERSION + 1, kind: 'secret', key: 'K' },
		});
	});
});

void describe('managed value JSON codec — schema-bearing markers (B1)', () => {
	void it('encodes the schema as an operational json bit (schema object is not serialized)', () => {
		const payload = encodeManagedValue(config('FLAGS', { schema: passthroughSchema }))[MANAGED_VALUE_JSON_TAG];
		assert.strictEqual(payload.json, true);
		assert.strictEqual(payload.key, 'FLAGS');
		// The un-serializable schema object itself is never placed on the wire.
		assert.ok(!('schema' in payload));
	});

	void it('a marker with no schema encodes with no json bit', () => {
		const encoded = encodeManagedValue(config('PLAIN'));
		assert.strictEqual('json' in encoded[MANAGED_VALUE_JSON_TAG], false);
	});

	void it('round-trip preserves the runtime JSON-parse behavior of a schema-bearing marker', () => {
		// A schema means "the runtime JSON-parses the stored value" (a per-key flag is
		// set at synth from `marker.schema`). The decoded marker must therefore still
		// carry a schema so the far side sets that flag — otherwise the value silently
		// comes back as a raw string instead of the parsed JSON value.
		const restored = decodeManagedValue(encodeManagedValue(secret('CONN', { schema: passthroughSchema })));
		assert.ok(isSecret(restored));
		assert.ok(restored.schema, 'schema-bearing marker must round-trip with a schema present');
	});

	void it('round-trip of a plain marker leaves it schema-free', () => {
		const restored = decodeManagedValue(encodeManagedValue(config('PLAIN')));
		assert.strictEqual(restored.schema, undefined);
	});
});

void describe('managed value JSON codec — malformed input & collisions (BN1, BN2)', () => {
	void it('decodeManagedValue accepts unknown and throws a typed error on malformed input', () => {
		for (const bad of [null, undefined, 'str', 42, {}, { nope: 1 }]) {
			assert.throws(() => decodeManagedValue(bad), ManagedValueCodecError);
		}
	});

	void it('a tagged object with extra sibling fields is NOT a wire value (no silent field loss)', () => {
		// Collision: an ordinary object that happens to carry the tag plus other data.
		// The reviver must leave it whole rather than replacing it with a marker and
		// dropping `extra`.
		const collision = {
			[MANAGED_VALUE_JSON_TAG]: { v: MANAGED_VALUE_JSON_VERSION, kind: 'secret', key: 'K' },
			extra: 'keep me',
		};
		assert.strictEqual(isManagedValueJSON(collision), false);
		assert.throws(() => decodeManagedValue(collision), ManagedValueCodecError);
		const restored = JSON.parse(JSON.stringify(collision), managedValueReviver);
		assert.deepStrictEqual(restored, collision);
	});

	void it('the reviver never throws on malformed tagged data — it leaves it untouched', () => {
		const wire = JSON.stringify({
			a: { [MANAGED_VALUE_JSON_TAG]: { v: MANAGED_VALUE_JSON_VERSION, kind: 'secret', key: 'a-b' } }, // bad key
			b: { [MANAGED_VALUE_JSON_TAG]: { v: MANAGED_VALUE_JSON_VERSION, kind: 'nope', key: 'K' } }, // bad kind
		});
		const restored = JSON.parse(wire, managedValueReviver) as Record<string, unknown>;
		assert.strictEqual(isManagedValue(restored.a), false);
		assert.strictEqual(isManagedValue(restored.b), false);
	});
});

void describe('managed value JSON codec — real cross-process boundary (B3)', () => {
	// This is the exact shape of the boundary an orchestrator (e.g. amplify-backend#3174)
	// uses: serialize per-stage config into a build ENVIRONMENT VARIABLE in one process,
	// then revive it in a *separate* process (a later build phase) and rely on the
	// secret/config semantics surviving. Same-process stringify/parse cannot catch a
	// regression here; a second OS process can.
	void it('nested markers (including a schema-bearing one) survive an env-var transport into a child process', () => {
		const original = {
			token: secret('TOKEN'),
			parsed: config('PARSED', { schema: passthroughSchema }),
			plain: 'literal',
			nested: { flag: config('FLAG') },
		};
		const wire = JSON.stringify(original, managedValueReplacer);

		// The child imports the very same compiled module this test runs against.
		const moduleUrl = new URL('./secret.js', import.meta.url).href;
		const childScript = `
			const { managedValueReviver, isSecret, isConfig } = await import(process.env.MODULE_URL);
			const r = JSON.parse(process.env.STAGE_CONFIG_JSON, managedValueReviver);
			process.stdout.write(JSON.stringify({
				token: isSecret(r.token) && r.token.key === 'TOKEN',
				parsed: isConfig(r.parsed) && r.parsed.key === 'PARSED',
				// The schema/json bit is what drives the runtime JSON-parse flag downstream;
				// it must survive the boundary or a schema-bearing value comes back raw.
				parsedRuntimeParses: !!r.parsed.schema,
				plain: r.plain === 'literal',
				nestedFlag: isConfig(r.nested.flag) && r.nested.flag.key === 'FLAG',
			}));
		`;

		const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', childScript], {
			encoding: 'utf8',
			env: { ...process.env, MODULE_URL: moduleUrl, STAGE_CONFIG_JSON: wire },
		});

		const result = JSON.parse(stdout) as Record<string, boolean>;
		assert.ok(result.token, 'secret() marker survived the process boundary');
		assert.ok(result.parsed, 'config() marker survived the process boundary');
		assert.ok(
			result.parsedRuntimeParses,
			'schema-bearing marker keeps its runtime JSON-parse behavior across processes',
		);
		assert.ok(result.plain, 'plain values are untouched');
		assert.ok(result.nestedFlag, 'nested markers survive the process boundary');
	});
});
