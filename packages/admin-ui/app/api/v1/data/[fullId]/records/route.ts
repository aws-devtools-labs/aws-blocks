// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from 'next/server';
import { API_VERSION, type ApiError, type DataMode, type WriteMode, type WriteResponse } from '@/contract/v1';
import { isAuthorizedToMutate } from '@/server/auth';
import { guardMutation } from '@/server/http-guards';
import { getDataProvider } from '@/server/provider-registry';
import { UNLOCK_TTL_MS, isUnlocked } from '@/server/write-guard';

const MODES: DataMode[] = ['local', 'cloud'];
const WRITE_MODES: WriteMode[] = ['create', 'edit'];

function isDataMode(value: unknown): value is DataMode {
	return typeof value === 'string' && (MODES as string[]).includes(value);
}

function isWriteMode(value: unknown): value is WriteMode {
	return typeof value === 'string' && (WRITE_MODES as string[]).includes(value);
}

function badRequest(message: string, status = 400): NextResponse<ApiError> {
	return NextResponse.json({ apiVersion: API_VERSION, error: { code: 'BAD_REQUEST' as const, message } }, { status });
}

/**
 * Outcome of the checks every record mutation shares.
 *
 * The ORDER below is the security-relevant part of this route, so it is
 * expressed once and reused by both verbs rather than written twice — two
 * copies of an ordered check list is how one of them ends up a step short.
 */
type Preflight =
	| { ok: true; body: Record<string, unknown>; stage: string; mode: DataMode }
	| { ok: false; response: NextResponse<ApiError> };

/**
 * Checks shared by POST and DELETE, cheapest and most decisive first:
 *
 * 1. Session token. Nothing else is worth spending on an unauthenticated caller.
 * 2. The mutation guard (Content-Type / Origin / Sec-Fetch-Site) — this runs
 *    before the body is read at all, because its whole purpose is to decide
 *    whether this request should be trusted enough to parse.
 * 3. JSON parse.
 * 4. `mode`, validated and never coerced.
 * 5. The unlock gate, for cloud only.
 *
 * Per-verb body shape is checked *after* all of it, in the handlers.
 */
async function preflight(request: NextRequest): Promise<Preflight> {
	if (!isAuthorizedToMutate(request.headers.get('authorization'))) {
		return {
			ok: false,
			response: NextResponse.json(
				{
					apiVersion: API_VERSION,
					error: { code: 'UNAUTHORIZED' as const, message: 'Missing or invalid session token' },
				},
				{ status: 401 },
			),
		};
	}

	// Ahead of the body: the guard decides whether this request looks like it
	// came from our own page, and a cross-site attempt should never reach the
	// parser. Its own status is forwarded (415 or 403) — only the message is
	// the guard's to write.
	const guard = guardMutation(request);
	if (!guard.ok) {
		return { ok: false, response: badRequest(guard.message, guard.status) };
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return { ok: false, response: badRequest('Request body must be valid JSON.') };
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { ok: false, response: badRequest('Request body must be a JSON object.') };
	}
	const parsed = body as Record<string, unknown>;

	const mode = parsed.mode;
	// Rejected, never coerced, and this matters more here than on the read: a
	// typo'd mode defaulting to local would write to a fixture file while the
	// user believes they are editing production. They would see a success, and
	// production would be untouched and unchanged — the worst outcome available
	// on this route, because it is a silent one.
	if (!isDataMode(mode)) {
		return {
			ok: false,
			response: badRequest(
				`Unknown mode "${String(mode)}" — expected one of: ${MODES.join(', ')}. A write mode is never inferred.`,
			),
		};
	}

	// The unlock gate is enforced HERE, at the route, and deliberately not in
	// the provider. Two reasons. It applies to a *request*, which is the thing
	// an unlock is scoped to; and keeping it out of the provider means a future
	// non-HTTP caller — a CLI command, a script, a background job — cannot
	// inherit "unlocked" from a browser session somebody left open.
	//
	// Cloud only. Local writes are NOT unlock-gated, and the asymmetry is
	// deliberate (DESIGN.md D7): `.bb-data` is dev fixture data inside the
	// user's own git tree, still token-gated and still refused while the dev
	// server runs, so demanding a production-grade unlock for it would be
	// friction without a matching blast radius.
	if (mode === 'cloud' && !isUnlocked()) {
		return {
			ok: false,
			response: NextResponse.json(
				{
					apiVersion: API_VERSION,
					error: {
						code: 'LOCKED' as const,
						message: `Cloud writes are locked. Unlock them with POST /api/v1/writes/unlock; an unlock lasts ${Math.round(UNLOCK_TTL_MS / 60_000)} minutes (${UNLOCK_TTL_MS} ms) from the moment it is granted.`,
					},
				},
				{ status: 403 },
			),
		};
	}

	const stage = typeof parsed.stage === 'string' && parsed.stage ? parsed.stage : 'sandbox';
	return { ok: true, body: parsed, stage, mode };
}

/** `fullId` arrives as a path segment, so it is percent-encoded in the URL. */
async function blockFullId(params: Promise<{ fullId: string }>): Promise<string> {
	return decodeURIComponent((await params).fullId);
}

function storeOf(body: Record<string, unknown>): string | undefined {
	return typeof body.store === 'string' && body.store ? body.store : undefined;
}

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ fullId: string }> },
): Promise<NextResponse<WriteResponse | ApiError>> {
	const checked = await preflight(request);
	if (!checked.ok) return checked.response;
	const { body, stage, mode } = checked;

	const { writeMode, item } = body;
	if (!isWriteMode(writeMode)) {
		return badRequest(`"writeMode" must be one of: ${WRITE_MODES.join(', ')}.`);
	}
	if (typeof item !== 'object' || item === null || Array.isArray(item)) {
		return badRequest('"item" must be a JSON object holding the record to write.');
	}

	const result = await getDataProvider().writeRecord({
		stage,
		mode,
		blockFullId: await blockFullId(params),
		store: storeOf(body),
		writeMode,
		item: item as Record<string, unknown>,
	});
	// 200 even when result.ok is false. A refusal is a successful request whose
	// answer is "no, and here is why" — non-2xx is reserved for auth, malformed
	// requests and the lock, so a client can tell "I asked wrongly" apart from
	// "I asked correctly and was declined".
	return NextResponse.json({ apiVersion: API_VERSION, ...result });
}

export async function DELETE(
	request: NextRequest,
	{ params }: { params: Promise<{ fullId: string }> },
): Promise<NextResponse<WriteResponse | ApiError>> {
	const checked = await preflight(request);
	if (!checked.ok) return checked.response;
	const { body, stage, mode } = checked;

	const { keyValues } = body;
	if (typeof keyValues !== 'object' || keyValues === null || Array.isArray(keyValues)) {
		return badRequest('"keyValues" must be a JSON object of key attribute names to string values.');
	}
	const entries = Object.entries(keyValues);
	// An empty keyValues must not become "delete whatever the writer defaults
	// to". A delete addresses exactly one record or it is a bad request.
	if (entries.length === 0) {
		return badRequest('"keyValues" must name at least one key attribute; a delete must address one record.');
	}
	if (!entries.every(([, value]) => typeof value === 'string')) {
		return badRequest('Every value in "keyValues" must be a string, as reported in a record\'s keyValues.');
	}

	const result = await getDataProvider().deleteRecord({
		stage,
		mode,
		blockFullId: await blockFullId(params),
		store: storeOf(body),
		keyValues: keyValues as Record<string, string>,
	});
	// 200 on a refusal, as in POST.
	return NextResponse.json({ apiVersion: API_VERSION, ...result });
}
