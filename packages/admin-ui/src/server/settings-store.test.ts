// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
	classifyReadError,
	parameterTypeFor,
	readLocalSettings,
	toStoredParameter,
} from './settings-store.js';

describe('toStoredParameter — the line a ciphertext must not cross', () => {
	/**
	 * The list path reads without decryption, so a SecureString's `Value` is a
	 * KMS ciphertext: useless to a reader and indistinguishable from a value.
	 * Dropped at the client boundary rather than at the display layer, so there
	 * is no path by which it reaches a response at all.
	 */
	it('drops a SecureString value read without decryption', () => {
		const stored = toStoredParameter(
			{ Type: 'SecureString', Value: 'AQICAHiabc...', Version: 4 },
			{ decrypted: false },
		);

		assert.equal(stored.raw, undefined);
		assert.equal(stored.type, 'SecureString');
		// The version still travels: it is not the secret, and it is what a
		// rollback and a "last changed" column need.
		assert.equal(stored.version, 4);
	});

	it('keeps a SecureString value that was decrypted on purpose', () => {
		const stored = toStoredParameter({ Type: 'SecureString', Value: '"real"' }, { decrypted: true });

		assert.equal(stored.raw, '"real"');
	});

	it('keeps a plain value on either path', () => {
		assert.equal(toStoredParameter({ Type: 'String', Value: '"on"' }, { decrypted: false }).raw, '"on"');
		assert.equal(toStoredParameter({ Type: 'String', Value: '"on"' }, { decrypted: true }).raw, '"on"');
	});

	it('reports the modification time as an ISO string', () => {
		const stored = toStoredParameter(
			{ Type: 'String', Value: '"on"', LastModifiedDate: new Date('2026-10-14T09:00:00Z') },
			{ decrypted: false },
		);

		assert.equal(stored.lastModified, '2026-10-14T09:00:00.000Z');
	});
});

describe('parameterTypeFor', () => {
	/**
	 * The line that decides whether a secret stays encrypted. Writing one as a
	 * `String` downgrades it from KMS-encrypted to plaintext, which nobody
	 * notices until the value turns up in a log.
	 */
	it('keeps a secret a SecureString and a plain value a String', () => {
		assert.equal(parameterTypeFor(true), 'SecureString');
		assert.equal(parameterTypeFor(false), 'String');
	});
});

describe('classifyReadError', () => {
	it('separates a refusal from a missing credential from an absent stack', () => {
		const cases: Array<[string, string, string]> = [
			['AccessDeniedException', 'not authorized', 'ACCESS_DENIED'],
			['CredentialsProviderError', 'could not load', 'NO_CREDENTIALS'],
			['ExpiredToken', 'token expired', 'NO_CREDENTIALS'],
			['ValidationError', 'Stack with id x does not exist', 'NOT_DEPLOYED'],
			['ThrottlingException', 'rate exceeded', 'UNKNOWN'],
		];
		for (const [name, message, code] of cases) {
			const error = Object.assign(new Error(message), { name });
			assert.equal(classifyReadError(error).code, code, name);
		}
	});

	it('keeps the original message, which is the only actionable part', () => {
		const error = Object.assign(new Error('User: arn:aws:sts::1:x is not authorized'), {
			name: 'AccessDeniedException',
		});

		assert.match(classifyReadError(error).message, /is not authorized/);
	});
});

describe('readLocalSettings', () => {
	let tmpDir: string;

	function makeProject(contents?: string): string {
		tmpDir = join(tmpdir(), `admin-ui-settings-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tmpDir, '.bb-data'), { recursive: true });
		if (contents !== undefined) writeFileSync(join(tmpDir, '.bb-data/settings.json'), contents);
		return tmpDir;
	}

	afterEach(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	it('reads the mock file keyed by fullId', () => {
		const values = readLocalSettings(makeProject(JSON.stringify({ 'shop-flag': 'on', 'shop-n': 3 })));

		assert.deepEqual([...values.entries()], [
			['shop-flag', 'on'],
			['shop-n', 3],
		]);
	});

	it('reads an absent file as empty, which is a project that has not run locally', () => {
		assert.equal(readLocalSettings(makeProject()).size, 0);
	});

	it('reads a corrupt or wrongly shaped file as empty rather than throwing', () => {
		// This feeds a dashboard whose job includes explaining a broken project,
		// so a rejection here would take out the view meant to describe it.
		assert.equal(readLocalSettings(makeProject('{not json')).size, 0);
		assert.equal(readLocalSettings(makeProject('["an","array"]')).size, 0);
		assert.equal(readLocalSettings(makeProject('null')).size, 0);
	});
});
