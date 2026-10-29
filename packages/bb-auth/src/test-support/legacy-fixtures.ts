// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Frozen outputs of the replaced auth blocks (test-only).
 *
 * `AuthBasic`, `AuthCognito` and `AuthOIDC` were deleted at the cutover (F1b).
 * The compatibility tests that compared `Auth` against them now compare
 * against what those blocks produced, captured from the real packages just
 * before they were deleted and committed under `src/__fixtures__/`:
 *
 * - `authcognito-templates.json` — `AuthCognito`'s synthesized CloudFormation
 *   per configuration and stack preset (`property-snapshot.cdk.test.ts`).
 *   Re-frozen in MERGE1 from `bb-auth-cognito` 0.1.11 with `origin/main`
 *   merged into the freezing commit, because `bb-kv-store` #635 added
 *   `SSESpecification` and `PointInTimeRecoverySpecification` to the nested
 *   sessions table that BOTH blocks create — the capture was otherwise stale
 *   on a dependency change, not on anything either auth block did.
 * - `legacy-mock-state.json` — what the old mocks left on disk and in the
 *   browser's cookie jar after a scenario (`native-mock.test.ts`,
 *   `session-compat.test.ts`, `auth-base.test.ts`).
 * - `authcognito-api/` — `@aws-blocks/bb-auth-cognito`'s published `.d.ts`
 *   API surface, so the codemod's "before" code still compiles against the
 *   real old types (`migrate-e2e.test.ts`). `ui.d.ts.txt` (the `/ui`
 *   sub-path) was added later: emitted with `tsc --declaration` from
 *   `packages/bb-auth-cognito/src/ui.ts` at the parent of the deletion commit
 *   (the file's only import is `@aws-blocks/auth-common/ui`'s types).
 *
 * The capture and its one-time equality proof against the live packages
 * (`legacy-fixtures.proof.test.ts`) ran in the commit that froze them, the
 * parent of the commit that deleted `packages/bb-auth-cognito`. To regenerate,
 * check that revision out (`git log -1 --format=%H -- packages/bb-auth-cognito/package.json`
 * names the deletion commit; use its parent), `npm ci && npm run build`, then
 * in `packages/bb-auth`: `UPDATE_LEGACY_FIXTURES=1 node --test dist/legacy-fixtures.proof.test.js`,
 * and copy the rewritten fixtures here. There is no other source for them.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CfnResourceJson, CfnTemplateJson } from './cdk-synth.js';

/** `packages/bb-auth/src/__fixtures__` (tests run from `dist/`; fixtures stay in `src/`). */
export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', '__fixtures__');

/** Where the mocks persist, relative to the test's working directory (the package root). */
export const MOCK_DATA_DIR = '.bb-data';

/**
 * One old-mock scenario as it was left behind: every file under `.bb-data/`,
 * the cookies the browser held, and the wall-clock moment the capture was
 * taken. Tests that restore it pin `Date` to `capturedAt`, so the captured
 * tokens and TTLs are exactly as fresh as they were when the old block wrote
 * them — the same instant a live upgrade would have run `Auth`.
 */
export interface MockStateCapture {
	/** What the old block did (the scenario), for humans. */
	scenario: string;
	/** The app scope id the old block was constructed under. */
	rootId: string;
	/** `Date.now()` right after the scenario finished. */
	capturedAt: number;
	/** Path relative to `.bb-data/` → file contents, byte for byte. */
	files: Record<string, string>;
	/** The browser's cookie jar (name → value) after the scenario. */
	cookies: Record<string, string>;
	/** Scenario-specific values the old block returned (e.g. the signed-in user, a session id). */
	results: Record<string, unknown>;
}

export interface MockStateFixture {
	$comment: string[];
	captures: Record<string, MockStateCapture>;
}

export function readFixtureJson<T>(name: string): T {
	return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')) as T;
}

/** A capture from `legacy-mock-state.json`; throws a clear error if it is missing. */
export function mockStateCapture(name: string): MockStateCapture {
	const capture = readFixtureJson<MockStateFixture>('legacy-mock-state.json').captures[name];
	if (!capture) throw new Error(`legacy-mock-state.json has no capture '${name}'`);
	return capture;
}

/** Write a capture's files back under `.bb-data/`, exactly as the old block left them. */
export function restoreMockFiles(capture: MockStateCapture): void {
	for (const [rel, text] of Object.entries(capture.files)) {
		const abs = join(MOCK_DATA_DIR, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, text);
	}
}

/** Every file under `.bb-data/`, relative path → contents (the capture side of {@link restoreMockFiles}). */
export function readMockFiles(): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const abs = join(dir, name);
			if (statSync(abs).isDirectory()) walk(abs);
			else out[relative(MOCK_DATA_DIR, abs)] = readFileSync(abs, 'utf8');
		}
	};
	walk(MOCK_DATA_DIR);
	return out;
}

// ─── authcognito-templates.json ──────────────────────────────────────────────

export type FrozenPreset = 'sandbox' | 'production';

/** One frozen `AuthCognito` synth: the full template and every `registerConfig()` entry. */
export interface FrozenSynth {
	/** The `AuthCognito` construct that was synthesized (a pair's `cognito` string). */
	construct: string;
	template: CfnTemplateJson;
	config: Record<string, unknown>;
}

/**
 * On disk, a resource that is identical in every frozen template (the harness
 * stack's shared infrastructure) is stored once, in `sharedResources`, and each
 * template holds this marker at its place. {@link frozenAuthCognitoSynths}
 * puts it back, so callers only ever see complete templates.
 */
export const SHARED_RESOURCE_MARKER = '$sharedResources';

export interface TemplatesFixtureFile {
	$comment: string[];
	/** The aws-cdk-lib version the templates were synthesized with. */
	awsCdkLib: string;
	sharedResources: Record<string, CfnResourceJson>;
	presets: Record<FrozenPreset, Record<string, FrozenSynth>>;
}

/** Store each resource identical across every synth once (the inverse of {@link frozenAuthCognitoSynths}). */
export function dedupeSharedResources(
	presets: Record<FrozenPreset, Record<string, FrozenSynth>>,
): Pick<TemplatesFixtureFile, 'sharedResources' | 'presets'> {
	const all = Object.values(presets).flatMap((p) => Object.values(p));
	const first = all[0]?.template.Resources ?? {};
	const sharedResources: Record<string, CfnResourceJson> = {};
	for (const [id, resource] of Object.entries(first)) {
		const text = JSON.stringify(resource);
		if (all.every((s) => JSON.stringify(s.template.Resources[id]) === text)) sharedResources[id] = resource;
	}
	const out = { sandbox: {}, production: {} } as Record<FrozenPreset, Record<string, FrozenSynth>>;
	for (const [preset, synths] of Object.entries(presets) as [FrozenPreset, Record<string, FrozenSynth>][]) {
		for (const [name, s] of Object.entries(synths)) {
			const Resources: Record<string, unknown> = {};
			for (const [id, r] of Object.entries(s.template.Resources)) {
				Resources[id] = id in sharedResources ? SHARED_RESOURCE_MARKER : r;
			}
			out[preset][name] = { ...s, template: { ...s.template, Resources } as CfnTemplateJson };
		}
	}
	return { sharedResources, presets: out };
}

/** `authcognito-templates.json` with every template complete again. */
export function frozenAuthCognitoSynths(): {
	awsCdkLib: string;
	presets: Record<FrozenPreset, Record<string, FrozenSynth>>;
} {
	const file = readFixtureJson<TemplatesFixtureFile>('authcognito-templates.json');
	const presets = { sandbox: {}, production: {} } as Record<FrozenPreset, Record<string, FrozenSynth>>;
	for (const [preset, synths] of Object.entries(file.presets) as [FrozenPreset, Record<string, FrozenSynth>][]) {
		for (const [name, s] of Object.entries(synths)) {
			const Resources: Record<string, CfnResourceJson> = {};
			for (const [id, r] of Object.entries(s.template.Resources as Record<string, unknown>)) {
				const shared = file.sharedResources[id];
				if (r === SHARED_RESOURCE_MARKER && !shared) throw new Error(`no shared resource '${id}'`);
				Resources[id] = r === SHARED_RESOURCE_MARKER ? structuredClone(shared) : (r as CfnResourceJson);
			}
			presets[preset][name] = { ...s, template: { ...s.template, Resources } };
		}
	}
	return { awsCdkLib: file.awsCdkLib, presets };
}

/**
 * `AuthCognito`'s mock accepting a password sign-in on a default pool
 * (`USER_PASSWORD_AUTH`, MFA off), as a predicate over its state file.
 *
 * Frozen from `bb-auth-cognito@0.1.10` `src/index.ts` — `loadFromDisk` (the
 * file is taken verbatim, missing top-level keys default to empty), `signIn`
 * (unknown or disabled user, wrong password, unconfirmed user and a pending
 * forced password change all refuse; with MFA off `selectSignInChallenge`
 * returns no challenge) and `issueSession` (reads the user's `userSub`, its
 * `attributes` and the `groups` map). `legacy-fixtures.proof.test.ts` checked
 * it against the live block, accepting and refusing alike, before the package
 * was deleted.
 */
export function authCognitoMockAcceptsPasswordSignIn(
	stateFileText: string,
	username: string,
	password: string,
): boolean {
	let state: unknown;
	try {
		state = JSON.parse(stateFileText);
	} catch {
		return false; // AuthCognito set an unparseable file aside and started empty.
	}
	if (!isRecord(state)) return false;
	const users = state.users ?? {};
	const groups = state.groups ?? {};
	if (!isRecord(users) || !isRecord(groups)) return false;
	if (!Object.hasOwn(users, username)) return false;
	const user = users[username];
	if (!isRecord(user) || user.disabled) return false;
	if (user.password !== password) return false;
	if (!user.confirmed) return false;
	if (user.forcePasswordChange) return false;
	if (typeof user.userSub !== 'string' || !isRecord(user.attributes)) return false;
	return Object.values(groups).every((members) => Array.isArray(members));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
