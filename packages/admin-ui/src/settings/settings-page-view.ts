// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SettingEntry, SettingValueKind, SettingVersion } from '../contract/v1.js';

/**
 * The settings page's decisions, with no React in them.
 *
 * Everything here answers a question the page would otherwise answer inline
 * and untestably: whether a row can be edited at all, what the editor should
 * start with, and whether a refusal is the user's to fix.
 */

/** Whether a row can be edited in the stage being shown, and why not. */
export interface Editability {
	editable: boolean;
	/** Present when `editable` is false. Plain words, no error code. */
	reason?: string;
}

/**
 * Whether this row can be written here.
 *
 * Deliberately permissive about a parameter the stage does not hold: writing
 * one CREATES it, which is the fix when it was deleted out of band rather than
 * an error. The one hard stop is a path we cannot name, because there is
 * nothing to write to.
 */
export function editability(entry: SettingEntry): Editability {
	if (entry.address === undefined) {
		return {
			editable: false,
			reason: 'This setting names its parameter with a variable, so the dashboard cannot tell which one it is. Change it where it is seeded.',
		};
	}
	return { editable: true };
}

/**
 * What the editor starts with.
 *
 * A secret starts EMPTY, always. Its stored value was never fetched, so
 * pre-filling it would either be a lie or require decrypting on page load,
 * which is the thing the read path is built to avoid. The user types a new
 * value or leaves it alone.
 */
export function initialInput(entry: SettingEntry): string {
	if (entry.secret) return '';
	if (entry.value === undefined || entry.value.masked) return '';
	return entry.value.display;
}

/**
 * Whether the editor should treat input as JSON by default.
 *
 * Read from the value already stored rather than guessed from the text: a
 * setting currently holding an object is being edited as JSON, and one holding
 * a string is being edited as text. A new or masked value defaults to text,
 * which is the choice that cannot silently change a type.
 */
export function initialKind(entry: SettingEntry): SettingValueKind {
	if (entry.secret || entry.value === undefined || entry.value.masked) return 'text';
	const display = entry.value.display;
	return display.startsWith('{') || display.startsWith('[') ? 'json' : 'text';
}

/** Settings grouped by the block that declares them, in declaration order. */
export function groupByFile(entries: readonly SettingEntry[]): Array<{ file: string; entries: SettingEntry[] }> {
	const groups = new Map<string, SettingEntry[]>();
	for (const entry of entries) {
		const existing = groups.get(entry.file);
		if (existing) existing.push(entry);
		else groups.set(entry.file, [entry]);
	}
	return [...groups.entries()].map(([file, grouped]) => ({ file, entries: grouped }));
}

/** One line saying what a row currently holds, for a reader scanning the list. */
export function valueSummary(entry: SettingEntry): string {
	if (entry.value !== undefined) return entry.value.display;
	switch (entry.valueHidden) {
		case 'not-present':
			return 'not set in this stage';
		case 'unaddressable':
			return 'path not readable from source';
		case 'unreadable':
			return entry.error ?? 'could not be read';
		default:
			return 'hidden';
	}
}

/**
 * The versions a non-secret row can be restored from.
 *
 * A secret's history carries no value (it is stored encrypted and read without
 * decryption), so there is nothing to restore and offering the button would be
 * an affordance that cannot work. The current version is dropped too: it is
 * already in the box.
 */
export function restorableVersions(
	entry: SettingEntry,
	versions: readonly SettingVersion[],
): SettingVersion[] {
	if (entry.secret) return [];
	return versions.filter(
		(version) => version.display !== undefined && version.version !== entry.value?.version,
	);
}

/** Whether a refusal is something the user can fix in the form in front of them. */
export function refusalIsFixableHere(code: string | undefined): boolean {
	return code === 'invalid-json' || code === 'too-large' || code === 'empty-secret';
}
