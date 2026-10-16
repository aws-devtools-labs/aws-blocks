// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Opaque pagination cursors for the data browser.
 *
 * The three stores paginate in three incompatible ways: a local `.bb-data` file
 * is an array we can offset into, DynamoDB hands back a `LastEvaluatedKey`
 * item, and Cognito hands back a `PaginationToken` string. Rather than leaking
 * three shapes into the HTTP contract, all three are encoded into one opaque
 * base64url token that the client echoes back verbatim.
 *
 * The reference implementation has no pagination at all: it issues a single
 * 100-item scan, reports `LastEvaluatedKey` only cosmetically in a label, and
 * ignores Cognito's `PaginationToken` outright — so nothing past the first page
 * is reachable and a 100-item page is indistinguishable from a 100,000-item
 * table. That is the gap this module exists to close.
 *
 * The cursor carries the store it was minted for, and a cursor presented for a
 * different store is rejected rather than applied: switching stores mid-browse
 * would otherwise resume at a meaningless position.
 */

/** Decoded cursor state, one variant per store kind. */
export type DataCursor =
	| { kind: 'offset'; store: string; offset: number }
	| { kind: 'dynamodb'; store: string; lastKey: Record<string, unknown> }
	| { kind: 'cognito'; store: string; token: string };

export class InvalidCursorError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidCursorError';
	}
}

/** Encodes a cursor as a base64url string safe to put in a query parameter. */
export function encodeCursor(cursor: DataCursor): string {
	return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

/**
 * Decodes a cursor, verifying it was minted for `expectedStore`.
 *
 * @throws InvalidCursorError when the token is malformed, structurally wrong,
 *         or belongs to a different store. A bad cursor is a caller error worth
 *         reporting, not something to silently treat as "start from the top" —
 *         silently restarting looks to the user like the last page repeating
 *         forever.
 */
export function decodeCursor(token: string, expectedStore: string): DataCursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
	} catch {
		throw new InvalidCursorError('Cursor is not a valid token.');
	}

	if (typeof parsed !== 'object' || parsed === null) {
		throw new InvalidCursorError('Cursor is not a valid token.');
	}
	const candidate = parsed as Record<string, unknown>;
	if (typeof candidate.store !== 'string' || candidate.store.length === 0) {
		throw new InvalidCursorError('Cursor is missing its store.');
	}
	if (candidate.store !== expectedStore) {
		throw new InvalidCursorError(
			`Cursor belongs to store "${candidate.store}", not "${expectedStore}". Start from the first page.`,
		);
	}

	switch (candidate.kind) {
		case 'offset': {
			const { offset } = candidate;
			if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
				throw new InvalidCursorError('Cursor offset is not a non-negative integer.');
			}
			return { kind: 'offset', store: candidate.store, offset };
		}
		case 'dynamodb': {
			const { lastKey } = candidate;
			if (typeof lastKey !== 'object' || lastKey === null || Array.isArray(lastKey)) {
				throw new InvalidCursorError('Cursor is missing its DynamoDB key.');
			}
			return { kind: 'dynamodb', store: candidate.store, lastKey: lastKey as Record<string, unknown> };
		}
		case 'cognito': {
			const { token: paginationToken } = candidate;
			if (typeof paginationToken !== 'string' || paginationToken.length === 0) {
				throw new InvalidCursorError('Cursor is missing its Cognito pagination token.');
			}
			return { kind: 'cognito', store: candidate.store, token: paginationToken };
		}
		default:
			throw new InvalidCursorError(`Unknown cursor kind: ${String(candidate.kind)}`);
	}
}

/** Default and maximum page sizes. A page is a UI concern, so keep it modest. */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/** Clamps a caller-supplied limit into range, falling back to the default. */
export function resolvePageLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
	const rounded = Math.floor(limit);
	if (rounded < 1) return DEFAULT_PAGE_LIMIT;
	return Math.min(rounded, MAX_PAGE_LIMIT);
}
