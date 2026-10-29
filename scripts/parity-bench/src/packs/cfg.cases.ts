// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Configuration (bb-secret + bb-app-setting) parity cases. Pure data — executed by cfg.probe.ts.
//
// Sizes are UTF-8 bytes of what the block actually sends to the service:
// - Secret (no schema) sends the string verbatim as `SecretString`.
// - AppSetting always sends `JSON.stringify(value)`, so a plain string gains two quote bytes.
//   Generated values use only [a-z0-9] and `€` (3 UTF-8 bytes, 1 UTF-16 unit), which
//   JSON.stringify never escapes, so serialized bytes = raw bytes + 2.

import type { ParityCase } from '../core/types.js';

const SM_PUT = 'https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_PutSecretValue.html';
const SM_GET = 'https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html';
const SM_SIZE = 'https://docs.aws.amazon.com/secretsmanager/latest/userguide/reference_secret_json_structure.html';
const SM_CONSISTENCY = 'https://docs.aws.amazon.com/secretsmanager/latest/userguide/troubleshoot.html';
const SM_GENERATE =
	'https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-secretsmanager-secret-generatesecretstring.md';
const SSM_PUT = 'https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_PutParameter.html';
const SSM_QUOTAS = 'https://docs.aws.amazon.com/general/latest/gr/ssm.html';

const secret = (c: Omit<ParityCase, 'pack' | 'block'>): ParityCase => ({ ...c, pack: 'cfg', block: 'bb-secret' });
const setting = (c: Omit<ParityCase, 'pack' | 'block'>): ParityCase => ({ ...c, pack: 'cfg', block: 'bb-app-setting' });

/** Secret.put() of an ASCII string at 65,536 bytes ± 1. */
const secretAsciiSize = [65535, 65536, 65537].map((bytes) =>
	secret({
		id: `cfg.secret-size.put.ascii-${bytes}`,
		category: 'limits',
		description: `Secret.put() a ${bytes}-byte ASCII string, then get() it back`,
		source: `${SM_PUT} (SecretString max length 65536); ${SM_SIZE} (max 65,536 bytes)`,
		params: { kind: 'secret-size', bytes, charset: 'ascii' },
	}),
);

/** AppSetting.put() of a string whose JSON-serialized form is 4,096 bytes ± 1. */
const settingAsciiSize = [4095, 4096, 4097].map((serializedBytes) =>
	setting({
		id: `cfg.setting-size.put.ascii-${serializedBytes}`,
		category: 'limits',
		description: `AppSetting.put() a string that is ${serializedBytes} bytes after the block's JSON encoding, then get() it back`,
		source: `${SSM_PUT} (standard parameters have a value limit of 4 KB); ${SSM_QUOTAS}`,
		params: { kind: 'setting-size', serializedBytes, charset: 'ascii', secret: false },
	}),
);

export const cfgCases: readonly ParityCase[] = [
	...secretAsciiSize,
	secret({
		id: 'cfg.secret-size.put.multibyte-65538',
		category: 'limits',
		description: 'Secret.put() a string of 65,538 UTF-8 bytes but only ~21,900 characters (mostly "€"): bytes or characters?',
		source: `${SM_SIZE} (max 65,536 bytes); ${SM_PUT} (SecretString max length 65536)`,
		params: { kind: 'secret-size', bytes: 65538, charset: 'multibyte' },
	}),
	secret({
		id: 'cfg.secret-empty.put.empty-string',
		category: 'errors',
		description: "Secret.put('') then get(): an empty SecretString",
		source: `${SM_PUT} (SecretString minimum length of 1)`,
		params: { kind: 'secret-empty' },
	}),
	secret({
		id: 'cfg.secret-chars.put.special-roundtrip',
		category: 'consistency',
		description: 'Secret.put() a value with quotes, backslash, newline, tab, CJK, emoji and JSON-looking text, then get()',
		source: `${SM_PUT} (SecretString is any text)`,
		params: { kind: 'secret-special' },
	}),
	secret({
		id: 'cfg.secret-consistency.put-get.read-after-write',
		category: 'consistency',
		description: "Secret.put(a); put(b); then immediately get(), get({ version: 'previous' }) and listVersions()",
		source: `${SM_CONSISTENCY} (eventual consistency); ${SM_PUT} (AWSCURRENT / AWSPREVIOUS label moves)`,
		params: { kind: 'secret-read-after-write' },
	}),
	secret({
		id: 'cfg.secret-version.get.malformed-version-id',
		category: 'errors',
		description: "Secret.get({ version: { versionId: 'not-a-version' } }) with a versionId shorter than 32 characters",
		source: `${SM_GET} (VersionId length 32-64); packages/bb-secret/src/types.ts (a versionId that does not exist reads back as null)`,
		params: { kind: 'secret-malformed-version' },
	}),
	secret({
		id: 'cfg.secret-generate.get.charset',
		category: 'security',
		description: 'A `generate: true` Secret: length and character classes of the seeded value (never the value itself)',
		source: `${SM_GENERATE} (default 32 chars, punctuation included); packages/bb-secret/src/types.ts (generate)`,
		params: { kind: 'secret-generate' },
	}),
	...settingAsciiSize,
	setting({
		id: 'cfg.setting-size.put.multibyte-4097',
		category: 'limits',
		description: 'AppSetting.put() a string of 4,097 UTF-8 bytes but ~1,390 characters after JSON encoding: bytes or characters?',
		source: `${SSM_PUT} (standard parameters have a value limit of 4 KB); packages/bb-app-setting/src/index.mock.ts (MAX_VALUE_BYTES)`,
		params: { kind: 'setting-size', serializedBytes: 4097, charset: 'multibyte', secret: false },
	}),
	setting({
		id: 'cfg.setting-size.put-secret.ascii-4097',
		category: 'limits',
		description: 'A `secret: true` AppSetting (SecureString): put() a string that is 4,097 bytes after JSON encoding',
		source: `${SSM_PUT} (4 KB standard-tier value limit applies to every parameter type); ${SSM_QUOTAS}`,
		params: { kind: 'setting-size', serializedBytes: 4097, charset: 'ascii', secret: true },
	}),
	setting({
		id: 'cfg.setting-chars.put.double-brace',
		category: 'errors',
		description: "AppSetting.put('Hello {{name}}, …'): a template string containing {{ }}, then get()",
		source: `${SSM_PUT} (you can't include values wrapped in double brackets {{}} in a parameter value)`,
		params: { kind: 'setting-double-brace' },
	}),
	setting({
		id: 'cfg.setting-alias.from-existing.reads-writer-value',
		category: 'consistency',
		description: 'AppSetting.fromExisting() on another AppSetting\'s parameter name: does it read the value the writer just put()?',
		source: `${SSM_PUT}; packages/bb-app-setting/src/index.mock.ts (fromExisting: "behaves like a normal setting keyed by its fullId")`,
		params: { kind: 'setting-alias' },
	}),
	setting({
		id: 'cfg.setting-throughput.put.burst-8',
		category: 'limits',
		description: 'Eight concurrent AppSetting.put() calls on one parameter: how many succeed, and with which error names',
		source: `${SSM_QUOTAS} (PutParameter default 3 TPS); ${SSM_PUT} (TooManyUpdates)`,
		params: { kind: 'setting-burst', writes: 8 },
	}),
];
