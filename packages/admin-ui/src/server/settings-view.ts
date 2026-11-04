// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SettingEntry, SettingValueView } from '../contract/v1.js';
import { REDACTED, redactValue } from './redact.js';
import { decodeSettingValue, type SettingRow } from './settings-inventory.js';
import type { StoredParameter } from './settings-store.js';

/**
 * Turning one read into what a reader is allowed to see.
 *
 * Pure, and separate from the module that does the reading, so the masking
 * rules can be tested exhaustively with no AWS and no project on disk. Every
 * `masked` flag is computed from what the read actually produced rather than
 * passed in by a caller: a caller that could assert its own redaction state is
 * how the implementation this package models shipped `redacted: false` beside a
 * path that redacted nothing.
 */

/** Display text for a value that is withheld. Shared so one mask is used everywhere. */
function maskedView(stored: StoredParameter | undefined): SettingValueView {
	const view: SettingValueView = { display: REDACTED, masked: true };
	// Version and timestamp are not the secret, and they are what makes a
	// rollback choosable and a "last changed" column possible, so they travel
	// with a masked value.
	if (stored?.version !== undefined) view.version = stored.version;
	if (stored?.lastModified !== undefined) view.lastModified = stored.lastModified;
	return view;
}

/**
 * One deployed setting as the list may show it.
 *
 * `stored` is what {@link fetchParameterValues} returned for this row's
 * address, or undefined when the account does not hold it.
 */
export function buildSettingEntry(row: SettingRow, stored: StoredParameter | undefined): SettingEntry {
	const entry: SettingEntry = { ...row };
	if (row.address === undefined) {
		entry.valueHidden = 'unaddressable';
		return entry;
	}
	if (stored === undefined) {
		entry.valueHidden = 'not-present';
		return entry;
	}
	// The live type outranks the declaration. A parameter declared non-secret
	// that is a SecureString in the account is masked on the strength of the
	// account, because that is a fact about the data rather than about source.
	if (row.secret || stored.type === 'SecureString' || stored.raw === undefined) {
		entry.value = maskedView(stored);
		entry.valueHidden = 'secret';
		return entry;
	}

	const decoded = decodeSettingValue(stored.raw);
	entry.value = displayValue(decoded.value, stored);
	entry.value.encoding = decoded.encoding;
	if (entry.value.masked) entry.valueHidden = 'secret';
	return entry;
}

/**
 * One local setting as the list may show it.
 *
 * The mock stores decoded values keyed by `fullId`, so there is no encoding to
 * read back: the file itself is the JSON. A declared secret is masked here too.
 * Its local value is usually a random placeholder, but `db pull` seeds that
 * same file from a real environment, so the one that matters is exactly the one
 * that would leak.
 */
export function buildLocalSettingEntry(row: SettingRow, held: boolean, value: unknown): SettingEntry {
	const entry: SettingEntry = { ...row };
	if (!held) {
		entry.valueHidden = 'not-present';
		return entry;
	}
	if (row.secret) {
		entry.value = maskedView(undefined);
		entry.valueHidden = 'secret';
		return entry;
	}
	entry.value = displayValue(value, undefined);
	if (entry.value.masked) entry.valueHidden = 'secret';
	return entry;
}

/**
 * What was just stored, as a write confirmation may show it.
 *
 * A secret's new value is masked here too. The user typed it a second ago, so
 * echoing it back buys nothing and puts a plaintext credential in a response
 * body that may be logged by whatever sits between the browser and this
 * process.
 */
export function storedView(value: unknown, secret: boolean): SettingValueView {
	if (secret) return maskedView(undefined);
	return displayValue(value, undefined);
}

/**
 * A decoded value as display text, masked when its SHAPE is a credential.
 *
 * The second line of defence, and the reason a plain `String` parameter is not
 * trusted just because nobody declared it secret: a developer who pastes a
 * bearer token into a non-secret setting has created a credential the
 * declaration knows nothing about. Shape is what catches that, which is the
 * same authority every data-browser read already passes through.
 */
function displayValue(value: unknown, stored: StoredParameter | undefined): SettingValueView {
	const redaction = redactValue(value);
	if (redaction.redacted) return maskedView(stored);
	const view: SettingValueView = {
		display: typeof redaction.value === 'string' ? redaction.value : JSON.stringify(redaction.value),
		masked: false,
	};
	if (stored?.version !== undefined) view.version = stored.version;
	if (stored?.lastModified !== undefined) view.lastModified = stored.lastModified;
	return view;
}
