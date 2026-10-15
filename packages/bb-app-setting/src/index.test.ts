// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, beforeEach, describe } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppSetting, AppSettingErrors } from './index.mock.js';

// Clean mock data between tests
beforeEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch {}
});

// ── Helper: minimal StandardSchemaV1 implementation ─────────────────────────

function makeSchema<T>(validate: (value: unknown) => T | null) {
	return {
		'~standard': {
			version: 1 as const,
			vendor: 'test',
			validate: (value: unknown) => {
				const result = validate(value);
				if (result !== null) return { value: result };
				return { issues: [{ message: 'Schema validation failed' }] };
			},
		},
	};
}

const configSchema = makeSchema<{ maxRetries: number; timeout: number }>((v) => {
	if (typeof v === 'object' && v !== null && 'maxRetries' in v && 'timeout' in v
		&& typeof (v as any).maxRetries === 'number' && typeof (v as any).timeout === 'number') {
		return v as { maxRetries: number; timeout: number };
	}
	return null;
});

// ═══════════════════════════════════════════════════════════════════════════
// Plain string settings
// ═══════════════════════════════════════════════════════════════════════════

describe('Plain string settings', () => {
	test('get returns provided value when no stored value exists', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'test', {
			name: '/app/test',
			value: 'hello',
		});
		assert.strictEqual(await setting.get(), 'hello');
	});

	test('put then get returns updated value', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'test', {
			name: '/app/test',
			value: 'initial',
		});
		await setting.put('updated');
		assert.strictEqual(await setting.get(), 'updated');
	});

	test('put overwrites previous value', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'test', {
			name: '/app/test',
			value: 'v1',
		});
		await setting.put('v2');
		await setting.put('v3');
		assert.strictEqual(await setting.get(), 'v3');
	});

	test('put with empty string is valid', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'test', {
			name: '/app/test',
			value: 'initial',
		});
		await setting.put('');
		assert.strictEqual(await setting.get(), '');
	});

	test('string values are stored as-is without JSON quoting', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'test', {
			name: '/app/test',
			value: 'hello world',
		});
		await setting.put('no "quotes" added');
		const result = await setting.get();
		assert.strictEqual(result, 'no "quotes" added');
	});

	test('unicode strings round-trip correctly', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'test', {
			name: '/app/test',
			value: '',
		});
		const unicode = '日本語テスト 🎉 émojis';
		await setting.put(unicode);
		assert.strictEqual(await setting.get(), unicode);
	});
	test('numeric value round-trips correctly without schema', async () => {
		const setting = new AppSetting<number>({ id: 'root' } as any, 'temp', {
			name: '/app/temp', value: 0.7,
		});
		await setting.put(0.7);
		const v = await setting.get();
		assert.strictEqual(v, 0.7);
		assert.strictEqual(typeof v, 'number');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Typed object settings with schema
// ═══════════════════════════════════════════════════════════════════════════

describe('Typed object settings with schema', () => {
	test('get returns initial object value', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'config', {
			name: '/app/config',
			value: { maxRetries: 3, timeout: 5000 },
			schema: configSchema,
		});
		assert.deepStrictEqual(await setting.get(), { maxRetries: 3, timeout: 5000 });
	});

	test('put then get returns updated object', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'config', {
			name: '/app/config',
			value: { maxRetries: 3, timeout: 5000 },
			schema: configSchema,
		});
		await setting.put({ maxRetries: 5, timeout: 10000 });
		assert.deepStrictEqual(await setting.get(), { maxRetries: 5, timeout: 10000 });
	});

	test('object values survive serialization round-trip', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'config', {
			name: '/app/config',
			value: { maxRetries: 0, timeout: 0 },
			schema: configSchema,
		});
		const values = [
			{ maxRetries: 0, timeout: 0 },
			{ maxRetries: 999, timeout: 999999 },
			{ maxRetries: -1, timeout: -1 },
		];
		for (const v of values) {
			await setting.put(v);
			assert.deepStrictEqual(await setting.get(), v);
		}
	});

	test('schema validation rejects invalid values on put', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'config', {
			name: '/app/config',
			value: { maxRetries: 3, timeout: 5000 },
			schema: configSchema,
		});
		await assert.rejects(
			() => setting.put({ wrong: 'field' } as any),
			(err: Error) => err.name === AppSettingErrors.ValidationFailed,
		);
	});

	test('value remains unchanged after failed schema validation', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'config', {
			name: '/app/config',
			value: { maxRetries: 3, timeout: 5000 },
			schema: configSchema,
		});
		await setting.put({ maxRetries: 10, timeout: 1000 });
		try {
			await setting.put({ bad: true } as any);
		} catch {}
		assert.deepStrictEqual(await setting.get(), { maxRetries: 10, timeout: 1000 });
	});

	test('schema validation rejects null', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'config', {
			name: '/app/config',
			value: { maxRetries: 3, timeout: 5000 },
			schema: configSchema,
		});
		await assert.rejects(
			() => setting.put(null as any),
			(err: Error) => err.name === AppSettingErrors.ValidationFailed,
		);
	});

	test('schema validation rejects string when object expected', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'config', {
			name: '/app/config',
			value: { maxRetries: 3, timeout: 5000 },
			schema: configSchema,
		});
		await assert.rejects(
			() => setting.put('not an object' as any),
			(err: Error) => err.name === AppSettingErrors.ValidationFailed,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Secret settings
// ═══════════════════════════════════════════════════════════════════════════

describe('Secret settings', () => {
	test('secret without value generates a random initial value', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'secret', {
			name: '/app/secret',
			secret: true,
		});
		const value = await setting.get();
		assert.ok(typeof value === 'string');
		assert.ok(value.length > 0);
	});

	test('two secret instances generate different random values', async () => {
		const s1 = new AppSetting({ id: 'root' } as any, 'secret1', {
			name: '/app/secret1',
			secret: true,
		});
		const s2 = new AppSetting({ id: 'root' } as any, 'secret2', {
			name: '/app/secret2',
			secret: true,
		});
		assert.notStrictEqual(await s1.get(), await s2.get());
	});

	test('secret value can be updated via put', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'secret', {
			name: '/app/secret',
			secret: true,
		});
		await setting.put('my-real-secret-value');
		assert.strictEqual(await setting.get(), 'my-real-secret-value');
	});

	test('secret put overwrites the random initial value', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'secret', {
			name: '/app/secret',
			secret: true,
		});
		const randomValue = await setting.get();
		await setting.put('explicit-secret');
		assert.strictEqual(await setting.get(), 'explicit-secret');
		assert.notStrictEqual(await setting.get(), randomValue);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Secret empty-string rejection
// ═══════════════════════════════════════════════════════════════════════════

describe('Secret empty-string rejection', () => {
	test('get() throws when secret parameter value is empty string', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'empty-secret', {
			name: '/app/empty-secret',
			secret: true,
		});
		// Force an empty string into storage (simulates SSM returning empty)
		await setting.put('placeholder');
		const { writeFileSync, readFileSync: rf } = await import('node:fs');
		const { join } = await import('node:path');
		const settingsPath = join('.bb-data', 'settings.json');
		const data = JSON.parse(rf(settingsPath, 'utf8'));
		data['root-empty-secret'] = '';
		writeFileSync(settingsPath, JSON.stringify(data));

		await assert.rejects(
			() => setting.get(),
			(err: Error) => {
				assert.strictEqual(err.name, AppSettingErrors.ParameterNotFound);
				assert.ok(err.message.includes('empty value'));
				assert.ok(err.message.includes('secrets must not be empty'));
				return true;
			},
		);
	});

	test('get() does NOT throw when non-secret parameter value is empty string', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'empty-nonsecret', {
			name: '/app/empty-nonsecret',
			value: 'initial',
		});
		await setting.put('');
		const result = await setting.get();
		assert.strictEqual(result, '');
	});

	test('get() works normally when secret has a real value', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'real-secret', {
			name: '/app/real-secret',
			secret: true,
		});
		await setting.put('super-secret-key-123');
		const result = await setting.get();
		assert.strictEqual(result, 'super-secret-key-123');
	});

	test('get() throws ParameterNotFound (not ValidationFailed) for empty secrets', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'errtype-secret', {
			name: '/app/errtype-secret',
			secret: true,
		});
		await setting.put('temp');
		const { writeFileSync, readFileSync: rf } = await import('node:fs');
		const { join } = await import('node:path');
		const settingsPath = join('.bb-data', 'settings.json');
		const data = JSON.parse(rf(settingsPath, 'utf8'));
		data['root-errtype-secret'] = '';
		writeFileSync(settingsPath, JSON.stringify(data));

		await assert.rejects(
			() => setting.get(),
			(err: Error) => {
				assert.strictEqual(err.name, AppSettingErrors.ParameterNotFound);
				assert.notStrictEqual(err.name, AppSettingErrors.ValidationFailed);
				return true;
			},
		);
	});

	test('auto-generated secret initial value is never empty', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'autogen-secret', {
			name: '/app/autogen-secret',
			secret: true,
		});
		// First get() returns the auto-generated value (should be non-empty)
		const value = await setting.get();
		assert.ok(typeof value === 'string');
		assert.ok(value.length > 0, 'Auto-generated secret must be non-empty');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 KB size limit
// ═══════════════════════════════════════════════════════════════════════════

describe('4 KB size limit', () => {
	test('put rejects values exceeding 4 KB for non-secret parameters', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'big', {
			name: '/app/big',
			value: '',
		});
		const bigValue = 'x'.repeat(5000);
		await assert.rejects(
			() => setting.put(bigValue),
			(err: Error) => err.name === AppSettingErrors.ValidationFailed,
		);
	});

	test('put accepts values at exactly 4096 bytes, including JSON.stringify overhead', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'exact', {
			name: '/app/exact',
			value: '',
		});
		// JSON.stringify adds 2 bytes for quotes around a plain string
		const exactValue = 'x'.repeat(4094);
		await setting.put(exactValue);
		assert.strictEqual(await setting.get(), exactValue);
	});

	test('put accepts values under 4096 bytes', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'small', {
			name: '/app/small',
			value: '',
		});
		const smallValue = 'x'.repeat(100);
		await setting.put(smallValue);
		assert.strictEqual(await setting.get(), smallValue);
	});

	test('size limit applies to serialized JSON for object values', async () => {
		const bigSchema = makeSchema<{ data: string }>((v) => {
			if (typeof v === 'object' && v !== null && 'data' in v && typeof (v as any).data === 'string') {
				return v as { data: string };
			}
			return null;
		});

		const setting = new AppSetting({ id: 'root' } as any, 'bigobj', {
			name: '/app/bigobj',
			value: { data: '' },
			schema: bigSchema,
		});

		// JSON.stringify({ data: 'x'.repeat(4090) }) is well over 4096 bytes
		await assert.rejects(
			() => setting.put({ data: 'x'.repeat(4090) }),
			(err: Error) => err.name === AppSettingErrors.ValidationFailed,
		);
	});

	test('size limit does not apply to secret parameters', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'bigsecret', {
			name: '/app/bigsecret',
			secret: true,
		});
		const bigValue = 'x'.repeat(5000);
		await setting.put(bigValue);
		assert.strictEqual(await setting.get(), bigValue);
	});

	test('value unchanged after size limit rejection', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'limit', {
			name: '/app/limit',
			value: 'original',
		});
		try {
			await setting.put('x'.repeat(5000));
		} catch {}
		assert.strictEqual(await setting.get(), 'original');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Disk persistence
// ═══════════════════════════════════════════════════════════════════════════

describe('Disk persistence', () => {
	test('data persists across instances with same scope path', async () => {
		const s1 = new AppSetting({ id: 'root' } as any, 'persist', {
			name: '/app/persist',
			value: 'initial',
		});
		await s1.put('saved');

		const s2 = new AppSetting({ id: 'root' } as any, 'persist', {
			name: '/app/persist',
			value: 'initial',
		});
		assert.strictEqual(await s2.get(), 'saved');
	});

	test('different scope paths have independent storage', async () => {
		const s1 = new AppSetting({ id: 'scope1' } as any, 'setting', {
			name: '/app/s1',
			value: 'value1',
		});
		const s2 = new AppSetting({ id: 'scope2' } as any, 'setting', {
			name: '/app/s2',
			value: 'value2',
		});
		await s1.put('updated1');
		assert.strictEqual(await s2.get(), 'value2'); // not affected by s1
	});

	test('mock stores data in .bb-data/settings.json', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'diskcheck', {
			name: '/app/diskcheck',
			value: 'initial',
		});
		await setting.put('written');
		const filePath = join('.bb-data', 'settings.json');
		assert.ok(existsSync(filePath));
		const content = JSON.parse(readFileSync(filePath, 'utf8'));
		assert.strictEqual(content['root-diskcheck'], 'written');
	});

	test('corrupted settings.json falls back to initial value', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'corrupt', {
			name: '/app/corrupt',
			value: 'fallback',
		});
		// Corrupt the shared settings file
		const { writeFileSync } = await import('node:fs');
		writeFileSync(join('.bb-data', 'settings.json'), 'not valid json{{{');

		assert.strictEqual(await setting.get(), 'fallback');
	});

});

// ═══════════════════════════════════════════════════════════════════════════
// Error constants
// ═══════════════════════════════════════════════════════════════════════════

describe('Error constants', () => {
	test('AppSettingErrors has ParameterNotFound', () => {
		assert.strictEqual(AppSettingErrors.ParameterNotFound, 'ParameterNotFoundException');
	});

	test('AppSettingErrors has ValidationFailed', () => {
		assert.strictEqual(AppSettingErrors.ValidationFailed, 'ValidationFailedException');
	});

	test('AppSettingErrors is typed as const', () => {
		// as const provides compile-time literal types, not runtime freezing
		// Verify the values are string literals (not just 'string')
		const pnf: 'ParameterNotFoundException' = AppSettingErrors.ParameterNotFound;
		const vf: 'ValidationFailedException' = AppSettingErrors.ValidationFailed;
		assert.ok(pnf);
		assert.ok(vf);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Scope integration
// ═══════════════════════════════════════════════════════════════════════════

describe('Scope integration', () => {
	test('fullId generation with parent', () => {
		const setting = new AppSetting({ id: 'parent' } as any, 'child', {
			name: '/app/child',
			value: 'test',
		});
		assert.strictEqual(setting.fullId, 'parent-child');
	});

	test('extends Scope', () => {
		const setting = new AppSetting({ id: 'root' } as any, 'test', {
			name: '/app/test',
			value: 'v',
		});
		assert.ok('fullId' in setting);
		assert.ok('id' in setting);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Default name (omitted name option)
// ═══════════════════════════════════════════════════════════════════════════

describe('Default name (omitted name option)', () => {
	test('constructor works without name option', () => {
		const setting = new AppSetting({ id: 'root' } as any, 'no-name', {
			value: 'hello',
		});
		assert.ok(setting);
		assert.strictEqual(setting.fullId, 'root-no-name');
	});

	test('get returns initial value when name is omitted', async () => {
		const setting = new AppSetting({ id: 'app' } as any, 'setting', {
			value: 'default-works',
		});
		assert.strictEqual(await setting.get(), 'default-works');
	});

	test('put then get works when name is omitted', async () => {
		const setting = new AppSetting({ id: 'app' } as any, 'rw', {
			value: 'initial',
		});
		await setting.put('updated');
		assert.strictEqual(await setting.get(), 'updated');
	});

	test('schema validation works when name is omitted', async () => {
		const setting = new AppSetting({ id: 'app' } as any, 'typed', {
			value: { maxRetries: 1, timeout: 100 },
			schema: configSchema,
		});
		assert.deepStrictEqual(await setting.get(), { maxRetries: 1, timeout: 100 });
		await setting.put({ maxRetries: 5, timeout: 500 });
		assert.deepStrictEqual(await setting.get(), { maxRetries: 5, timeout: 500 });
	});

	test('secret works when name is omitted', async () => {
		const setting = new AppSetting({ id: 'app' } as any, 'secret', {
			secret: true,
		});
		const val = await setting.get();
		assert.ok(typeof val === 'string' && val.length > 0);
	});

	test('explicit name still works as override', async () => {
		const setting = new AppSetting({ id: 'app' } as any, 'explicit', {
			name: '/custom/path',
			value: 'override',
		});
		assert.strictEqual(await setting.get(), 'override');
	});

	test('two AppSettings without name have independent storage', async () => {
		const s1 = new AppSetting({ id: 'root' } as any, 'alpha', { value: 'a' });
		const s2 = new AppSetting({ id: 'root' } as any, 'beta', { value: 'b' });
		await s1.put('updated-a');
		assert.strictEqual(await s1.get(), 'updated-a');
		assert.strictEqual(await s2.get(), 'b');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe('Edge cases', () => {
	test('multiple puts in sequence all succeed', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'multi', {
			name: '/app/multi',
			value: '',
		});
		for (let i = 0; i < 20; i++) {
			await setting.put(`value-${i}`);
		}
		assert.strictEqual(await setting.get(), 'value-19');
	});

	test('get is idempotent — multiple calls return same value', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'idem', {
			name: '/app/idem',
			value: 'stable',
		});
		assert.strictEqual(await setting.get(), 'stable');
		assert.strictEqual(await setting.get(), 'stable');
		assert.strictEqual(await setting.get(), 'stable');
	});

	test('value with special JSON characters round-trips correctly', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'special', {
			name: '/app/special',
			value: '',
		});
		const special = '{"key": "value", "nested": [1,2,3]}';
		await setting.put(special);
		assert.strictEqual(await setting.get(), special);
	});

	test('newlines and tabs in string values preserved', async () => {
		const setting = new AppSetting({ id: 'root' } as any, 'whitespace', {
			name: '/app/whitespace',
			value: '',
		});
		const value = 'line1\nline2\ttab';
		await setting.put(value);
		assert.strictEqual(await setting.get(), value);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Option validation — local mock rejects the same invalid combinations the
// CDK constructor rejects at synth (issue #577). These are synchronous option
// checks, so mock and CDK must throw identically.
// ═══════════════════════════════════════════════════════════════════════════

describe('Option validation (parity with CDK)', () => {
	function rejectsValidation(fn: () => unknown, msgIncludes?: string) {
		assert.throws(fn, (err: Error) => {
			assert.strictEqual(err.name, AppSettingErrors.ValidationFailed);
			if (msgIncludes) assert.ok(err.message.includes(msgIncludes), `message should include "${msgIncludes}", got: ${err.message}`);
			return true;
		});
	}

	test('non-secret setting without a value throws (no longer silently defaults to "")', () => {
		rejectsValidation(
			() => new AppSetting({ id: 'root' } as any, 'no-value', { name: '/app/no-value' }),
			'non-secret settings require a value',
		);
	});

	test("'secret' and 'schema' together throw", () => {
		const schema = makeSchema<string>((v) => (typeof v === 'string' ? v : null));
		rejectsValidation(
			() => new AppSetting({ id: 'root' } as any, 'secret-schema', { secret: true, schema } as any),
			"'secret' and 'schema' cannot be used together",
		);
	});

	test('schema without a value throws', () => {
		const schema = makeSchema<string>((v) => (typeof v === 'string' ? v : null));
		rejectsValidation(
			() => new AppSetting({ id: 'root' } as any, 'schema-no-value', { schema } as any),
			'a schema is provided but no value',
		);
	});

	test("'kmsKeyArn' without 'secret: true' throws", () => {
		rejectsValidation(
			() => new AppSetting({ id: 'root' } as any, 'kms-no-secret', { value: 'x', kmsKeyArn: 'arn:aws:kms:us-east-1:111122223333:key/abc' }),
			"'kmsKeyArn' is only valid with 'secret: true'",
		);
	});

	test('empty kmsKeyArn throws', () => {
		rejectsValidation(
			() => new AppSetting({ id: 'root' } as any, 'kms-empty', { secret: true, kmsKeyArn: '   ' }),
			"'kmsKeyArn' must be a non-empty KMS key ARN",
		);
	});

	test('secret with a value throws', () => {
		rejectsValidation(
			() => new AppSetting({ id: 'root' } as any, 'secret-value', { secret: true, value: 'hardcoded' as any }),
			'secrets should not have a value in source code',
		);
	});

	test('external without a name throws', () => {
		rejectsValidation(
			() => AppSetting.fromExisting({ id: 'root' } as any, 'ext-no-name', { name: '' }),
			"'external' requires an explicit 'name'",
		);
	});

	// ── Valid combinations must NOT throw ──────────────────────────────────
	test('non-secret with a value is valid', () => {
		assert.doesNotThrow(() => new AppSetting({ id: 'root' } as any, 'ok-value', { value: 'hello' }));
	});

	test('secret without a value is valid (random generated)', () => {
		assert.doesNotThrow(() => new AppSetting({ id: 'root' } as any, 'ok-secret', { secret: true }));
	});

	test('secret with a valid kmsKeyArn is valid', () => {
		assert.doesNotThrow(() => new AppSetting({ id: 'root' } as any, 'ok-kms', { secret: true, kmsKeyArn: 'arn:aws:kms:us-east-1:111122223333:key/abc' }));
	});

	test('fromExisting with a name is valid', () => {
		assert.doesNotThrow(() => AppSetting.fromExisting({ id: 'root' } as any, 'ok-ext', { name: '/app/existing' }));
	});
});
