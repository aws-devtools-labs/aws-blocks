// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Layer 1 of the immutability guard (decision Q5): a **committed baseline
 * file** per block, diffed at synth.
 *
 * Where it lives: `<app>/aws-blocks/baselines/<stack>/<fullId>.auth-pool.json`
 * — next to the backend handler file the `BlocksStack` was created with
 * (`backendHandlerPath`, an absolute path in every template), so it lands in
 * the app's own source tree and resolves to the same file whatever directory
 * synth runs from. Keyed by the stack name and the block's `fullId`.
 *
 * What it records: whether the block owns a user pool and, if so, the four
 * service-immutable properties (`immutability.ts`).
 *
 * - No baseline yet → write one, ask for it to be committed, pass.
 * - A permitted change (anything outside the four, an added custom attribute,
 *   a pool being added) → pass and rewrite the baseline.
 * - A change to one of the four, or the pool going away when the baseline
 *   says it exists → fail synth with the property, old → new, the reason and
 *   the remedy. The baseline is left untouched.
 * - `BLOCKS_AUTH_REBASELINE=<fullId>[,<fullId>…]` → deliberately accept the
 *   current configuration: rewrite the baseline and pass.
 *
 * A baseline whose block is gone (renamed id, or removed) is not checked here
 * — no block reads it. While it records an owned pool it carries a
 * `removalGuard`, and `@aws-blocks/core`'s stack-level check (on every
 * `BlocksStack` / `BlocksBackend`) fails synth for it; that check deletes it
 * on `BLOCKS_AUTH_REBASELINE=<that fullId>` (task D4b).
 *
 * Node `fs` only — runs inside the app's synth process.
 *
 * @internal
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
	BASELINE_FORMAT_VERSION,
	type BaselineRemovalGuard,
	readBaselineFormatVersion,
} from '@aws-blocks/core/cdk/internal';
import { diffImmutables, type PoolImmutables, parseSnapshot, REMEDY, type Violation } from './immutability.js';

/** The escape hatch: a comma-separated list of block `fullId`s to re-baseline on this synth. */
export const REBASELINE_ENV = 'BLOCKS_AUTH_REBASELINE';

/**
 * The `@aws-blocks/core` baseline **file-format** version this build of bb-auth
 * writes as the file's top-level `version`. A literal on purpose, NOT core's
 * `BASELINE_FORMAT_VERSION`: core and bb-auth are released independently
 * (bb-auth takes core by caret range), and core keeps reading every version from
 * 1 to its newest, so writing the version this code was built for is always
 * readable by a core at least that new — checked in {@link checkBaseline}.
 *
 * `version` is core's (it covers `fullId` and `removalGuard`). If bb-auth's own
 * fields (`ownsPool`, `pool`) ever change shape, they get a bb-auth field-level
 * version of their own; this constant does not change for that.
 *
 * @internal
 */
export const BASELINE_WRITE_VERSION = 1;

/** What the current synth provisions for one block. */
export interface PoolState {
	/** The block creates (owns) an `AWS::Cognito::UserPool`. `false` for a pool-less (Q6) or wrapped (`userPool`) config. */
	ownsPool: boolean;
	/** The four properties; `null` exactly when `ownsPool` is `false`. */
	pool: PoolImmutables | null;
}

/** The on-disk baseline. */
export interface PoolBaseline extends PoolState {
	$comment: string;
	/** The file-format version ({@link BASELINE_WRITE_VERSION} when this build writes it). */
	version: number;
	stack: string;
	fullId: string;
	/**
	 * Present exactly when `ownsPool` is `true`. Read by `@aws-blocks/core`'s
	 * stack-level check, which runs even when no `Auth` block is left: a
	 * baseline carrying it that no block claims means the block was renamed or
	 * removed, and CloudFormation would delete its pool.
	 */
	removalGuard?: BaselineRemovalGuard;
}

/** The `DESIGN.md` section an orphaned baseline points at. */
export const RENAME_RUNBOOK = '"Renaming or removing an Auth block" in the @aws-blocks/bb-auth DESIGN.md';

/** The removal guard written into the baseline of a block that owns its pool (`userPoolName` is the `fullId`). */
export function poolRemovalGuard(fullId: string): BaselineRemovalGuard {
	return {
		deletes: `the Cognito user pool '${fullId}' and every user in it`,
		rebaselineEnv: REBASELINE_ENV,
		runbook: RENAME_RUNBOOK,
	};
}

export type BaselineOutcome =
	| { status: 'created' | 'updated' | 'rebaselined' | 'unchanged' | 'deferred'; file: string }
	| { status: 'rejected'; file: string; violations: Violation[]; message: string };

/** `<appDir>/baselines/<stack>/<fullId>.auth-pool.json`. */
export function baselinePath(appDir: string, stack: string, fullId: string): string {
	return join(appDir, 'baselines', stack, `${fullId}.auth-pool.json`);
}

/** Whether `BLOCKS_AUTH_REBASELINE` names this block. */
export function rebaselineRequested(env: Record<string, string | undefined>, fullId: string): boolean {
	return (env[REBASELINE_ENV] ?? '')
		.split(',')
		.map((s) => s.trim())
		.includes(fullId);
}

function serialize(stack: string, fullId: string, state: PoolState): string {
	const baseline: PoolBaseline = {
		$comment:
			'Generated by @aws-blocks/bb-auth at synth. Commit this file. It records the user-pool properties Cognito ' +
			`cannot change after creation; a synth that changes one fails. Do not edit by hand — re-baseline with ${REBASELINE_ENV}=${fullId}.`,
		version: BASELINE_WRITE_VERSION,
		stack,
		fullId,
		ownsPool: state.ownsPool,
		pool: state.pool,
		...(state.ownsPool ? { removalGuard: poolRemovalGuard(fullId) } : {}),
	};
	return `${JSON.stringify(baseline, null, '\t')}\n`;
}

function write(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

/** A baseline file that cannot be read by this version: newer, or with an invalid `version`. */
type UnreadableVersion = { status: 'newer'; version: number } | { status: 'invalid'; version: unknown };

/** The parsed JSON object, or `undefined` when the file is not a JSON object. */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** The file's format version when this version cannot read it (core's rules: absent → 1, 1..newest, else newer/invalid). */
function unreadableVersion(record: Record<string, unknown> | undefined, newest: number): UnreadableVersion | undefined {
	if (!record) return undefined;
	const format = readBaselineFormatVersion({ file: record, newest });
	return format.status === 'supported' ? undefined : format;
}

function parseBaseline(record: Record<string, unknown> | undefined, fullId: string): PoolState | undefined {
	if (!record || record.fullId !== fullId || typeof record.ownsPool !== 'boolean') return undefined;
	if (!record.ownsPool) return { ownsPool: false, pool: null };
	const pool = parseSnapshot(record.pool);
	return pool ? { ownsPool: true, pool } : undefined;
}

function versionRejection(
	fullId: string,
	file: string,
	unreadable: UnreadableVersion,
	newest: number,
	rebaseline: boolean,
): string {
	if (unreadable.status === 'newer') {
		return [
			`Auth '${fullId}': the baseline ${display(file)} uses format version ${unreadable.version}, written by a newer`,
			`version of @aws-blocks/bb-auth or @aws-blocks/core; this version reads versions 1 to ${newest}, so the user-pool`,
			'immutability check cannot run. Upgrade @aws-blocks/bb-auth and @aws-blocks/core to match. The file is left as it is.',
			...(rebaseline
				? [
						`${REBASELINE_ENV} does not re-baseline over it: that would replace a newer file with an older format.`,
					]
				: []),
		].join('\n');
	}
	return [
		`Auth '${fullId}': the baseline ${display(file)} is not a valid baseline file: its \`version\` is`,
		`${JSON.stringify(unreadable.version)}, but must be a whole number from 1. Restore it from version control.`,
		'The file is left as it is.',
		...(rebaseline
			? [
					`${REBASELINE_ENV} does not overwrite it. To start a fresh baseline deliberately, delete the file first.`,
				]
			: []),
	].join('\n');
}

/** `file` relative to the working directory when it is inside it, else absolute. */
function display(file: string): string {
	const rel = relative(process.cwd(), file);
	return rel && !rel.startsWith('..') ? rel : file;
}

/**
 * The synth-failure message for a guarded change or a pool removal.
 *
 * The baseline advances at every passing synth, not at deploy, so what it
 * records may never have reached AWS (a synth that was never deployed, or a
 * deploy that failed). Layer 1 cannot know which holds — a plain `cdk deploy`
 * and a `cdk synth` look the same from inside the synth — so it refuses
 * either way and names both cases:
 *
 * - A change to one of the four properties: the violations first, so the
 *   reader sees what is wrong before any command; then the never-deployed
 *   re-baseline (a wrong one is backed by layer 2, which still refuses the
 *   change against a deployed pool); then the revert advice.
 * - A pool removal leads with the danger and how to check the deployed
 *   stack, and only then the never-deployed re-baseline: nothing at deploy
 *   time refuses a removal (layer 2 is removed with the pool), so a wrong
 *   re-baseline deletes the pool and every user in it.
 */
function rejection(fullId: string, file: string, violations: Violation[]): string {
	const headline = `Auth '${fullId}': this change cannot be deployed to the existing user pool.`;
	const listed = violations.flatMap((v) => [`  • ${v.change}`, `    ${v.why}`]);
	const rebaseline = `${REBASELINE_ENV}=${fullId} <your synth/deploy command>`;
	if (violations.some((v) => v.property === 'poolRemoved')) {
		return [
			headline,
			'This removes the user pool. If it was ever deployed, the next deploy deletes it and every user in it, and ' +
				'nothing at deploy time stops that. Check your deployed stack first (e.g. `aws cloudformation ' +
				'describe-stack-resources --stack-name <your stack>`, or the CloudFormation console) for an ' +
				`\`AWS::Cognito::UserPool\` (named '${fullId}' in Cognito).`,
			`If it was never deployed, re-baseline: ${rebaseline}, then commit the file. The baseline advances when you ` +
				'synthesize, not when you deploy, so it can record a pool that never reached AWS.',
			...listed,
			'',
			'If the pool was deployed — Remedy: keep a pool-backed sign-in method (email + password, a social or SAML ' +
				"provider, or an OIDC provider with `federateVia: 'cognito'`), and keep owning the pool rather than wrapping " +
				'one via `userPool`.',
			`Baseline: ${display(file)}.`,
			`If removing the pool is deliberate, re-baseline: ${rebaseline}, then commit the file.`,
		].join('\n');
	}
	return [
		headline,
		...listed,
		'',
		`If this was never deployed, re-baseline: ${rebaseline}, then commit the file. The baseline advances when ` +
			'you synthesize, not when you deploy, so it can record a change that never reached AWS. (Re-baselining does ' +
			'not make Cognito accept a change to a deployed pool; the deploy-time guard still refuses it.)',
		`If it was deployed — Remedy: ${REMEDY}`,
		`Baseline: ${display(file)}.`,
	].join('\n');
}

/**
 * Compare the current synth against the baseline at `file`, and write the
 * baseline when the outcome allows it. Never throws on a missing file; the
 * caller fails synth on `status: 'rejected'`.
 */
export function checkBaseline(input: {
	file: string;
	stack: string;
	fullId: string;
	current: PoolState;
	rebaseline: boolean;
	/**
	 * `false` holds back writing a baseline that does not exist yet (status
	 * `deferred`): the stack's synth fails on an orphaned baseline, and after a
	 * rename this new file would be the renamed block's (task D4b).
	 * @default true
	 */
	mayCreate?: boolean;
	/**
	 * The newest baseline format the installed `@aws-blocks/core` reads.
	 * @default `BASELINE_FORMAT_VERSION` from `@aws-blocks/core/cdk/internal`
	 */
	coreFormatVersion?: number;
}): BaselineOutcome {
	const { file, stack, fullId, current } = input;
	const newest = input.coreFormatVersion ?? BASELINE_FORMAT_VERSION;
	if (BASELINE_WRITE_VERSION > newest) {
		return {
			status: 'rejected',
			file,
			violations: [],
			message:
				`Auth '${fullId}': this @aws-blocks/bb-auth writes baseline format version ${BASELINE_WRITE_VERSION}, but the ` +
				`installed @aws-blocks/core reads versions 1 to ${newest} only. Upgrade @aws-blocks/core (and @aws-blocks/blocks).`,
		};
	}
	const content = serialize(stack, fullId, current);
	const raw = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
	const record = raw === undefined ? undefined : parseJsonObject(raw);
	// This build reads up to the version it writes (a newer bb-auth's file may carry
	// fields it would drop on rewrite) and up to what the installed core reads.
	const readable = Math.min(newest, BASELINE_WRITE_VERSION);
	// Never overwrite a file this version cannot read — not even to re-baseline.
	const unreadable = unreadableVersion(record, readable);
	if (unreadable) {
		return {
			status: 'rejected',
			file,
			violations: [],
			message: versionRejection(fullId, file, unreadable, readable, input.rebaseline),
		};
	}
	if (input.rebaseline) {
		write(file, content);
		return { status: 'rebaselined', file };
	}
	if (raw === undefined) {
		if (input.mayCreate === false) return { status: 'deferred', file };
		write(file, content);
		return { status: 'created', file };
	}
	const baseline = parseBaseline(record, fullId);
	if (!baseline) {
		const violations: Violation[] = [];
		return {
			status: 'rejected',
			file,
			violations,
			message: [
				`Auth '${fullId}': the baseline ${display(file)} is unreadable or belongs to another block, so the`,
				'user-pool immutability check cannot run. Restore it from version control, or re-baseline deliberately:',
				`${REBASELINE_ENV}=${fullId} <your synth/deploy command>, then commit the file.`,
			].join('\n'),
		};
	}

	const violations: Violation[] = [];
	if (baseline.ownsPool && !current.ownsPool) {
		violations.push({
			property: 'poolRemoved',
			change: 'the user pool would be removed from the stack (no pool-backed sign-in method is left, or `userPool` now wraps another pool)',
			why:
				'CloudFormation deletes a resource that leaves the template. Under a destroy removal policy that deletes the pool and every ' +
				"user in it; under 'retain' the pool is orphaned, and re-adding a pool-backed method later creates a new, empty pool.",
		});
	} else if (baseline.pool && current.pool) {
		violations.push(...diffImmutables(baseline.pool, current.pool));
	}
	if (violations.length > 0) {
		return { status: 'rejected', file, violations, message: rejection(fullId, file, violations) };
	}
	if (raw === content) return { status: 'unchanged', file };
	write(file, content);
	return { status: 'updated', file };
}
