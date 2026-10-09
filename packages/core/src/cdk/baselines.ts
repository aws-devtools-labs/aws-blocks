// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Committed synth baselines, and the stack-level check that a block which
 * left the app did not leave a stateful resource to be deleted.
 *
 * A Building Block that must refuse a destructive change at synth writes a
 * **baseline file** per instance into the app's source tree, keyed by the
 * owning stack and the block's `fullId`:
 *
 * ```
 * <dirname(backendHandlerPath)>/baselines/<stack>/<file>.json
 * ```
 *
 * The block itself compares the current synth against its own file. What it
 * cannot see is its own absence: when the block is renamed (a new `fullId`)
 * or deleted, nothing reads the old file, and CloudFormation deletes the
 * resource it guarded. That check therefore lives here, on every
 * `BlocksStack` / `BlocksBackend`, so it runs even when the app has no
 * instance of the block left — and when the block's package is no longer
 * imported at all. It needs no code from the block: a baseline that guards a
 * stateful resource says so in its own content (`removalGuard`, a
 * {@link BaselineRemovalGuard}).
 *
 * The protocol, for a Building Block author:
 *
 * 1. In the block's constructor, {@link claimBaseline} the file the block
 *    reads (absolute path, inside {@link baselineDir}).
 * 2. Write the file with a top-level `fullId` and, while the block owns the
 *    stateful resource, a `removalGuard`. Drop `removalGuard` once it owns
 *    none.
 * 3. At synth, every `*.json` file in the stack's baseline directory that has
 *    a `removalGuard` and is claimed by no block in this stack fails synth.
 *    `<removalGuard.rebaselineEnv>=<fullId>` deletes it instead (the exact
 *    `fullId`, never a blanket value).
 * 4. In a synth that fails this way ({@link hasOrphanedBaselines}), do not
 *    write a *new* baseline: after a rename it would be the renamed block's,
 *    and would itself turn up as orphaned once the old id is restored.
 *
 * `bb-auth` (the user-pool immutability guard) is the first user.
 *
 * Reads and deletes files with Node `fs`, at synth, inside the app's synth process.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import type { Construct, IConstruct } from 'constructs';

/**
 * Written by a Building Block into a baseline file that guards a stateful
 * resource, as the file's top-level `removalGuard` field. The stack-level
 * check reads it to explain an orphaned baseline without loading the block.
 */
export interface BaselineRemovalGuard {
	/**
	 * What CloudFormation deletes when the block leaves the stack, as a phrase
	 * that completes "CloudFormation will delete …" — e.g.
	 * `the Cognito user pool 'prod-auth' and every user in it`.
	 */
	deletes: string;
	/**
	 * The block's re-baseline variable. `<rebaselineEnv>=<fullId>[,<fullId>…]`
	 * deletes this file deliberately. Must start with `BLOCKS_`; a value that
	 * does not name this `fullId` exactly (e.g. `=1`) does nothing.
	 */
	rebaselineEnv: string;
	/** Where to read how to keep the resource under a new id (CloudFormation import). */
	runbook: string;
}

const ROOT_KEY = Symbol.for('BLOCKS_BASELINE_ROOT');

/** One problem the stack-level check reports. */
type Finding =
	| { kind: 'orphan'; file: string; fullId: string; guard: BaselineRemovalGuard }
	| { kind: 'rebaselined'; file: string; fullId: string; guard: BaselineRemovalGuard }
	| { kind: 'unreadable'; file: string };

interface BaselineRoot {
	/** Absolute paths claimed by blocks under this stack/backend. */
	claimed: Set<string>;
	/** Where the files live; `undefined` when the root has no `backendHandlerPath`. */
	dir?: () => { dir: string; stackName: string };
	/** The scan, computed once on first use — at validation, when every block has claimed. */
	findings?: Finding[];
}

function rootState(construct: IConstruct): BaselineRoot | undefined {
	return (construct as unknown as Record<symbol, BaselineRoot | undefined>)[ROOT_KEY];
}

/** The owning stack/backend's state: nearest ancestor that carries it, else the ambient stack (as `Scope` resolves its root). */
function findRoot(scope: IConstruct): BaselineRoot | undefined {
	for (let current: IConstruct | undefined = scope; current; current = current.node.scope) {
		const state = rootState(current);
		if (state) return state;
	}
	const ambient = (globalThis as { CURRENT_BLOCKS_STACK?: IConstruct }).CURRENT_BLOCKS_STACK;
	return ambient ? rootState(ambient) : undefined;
}

/**
 * `<dirname(backendHandlerPath)>/baselines/<stackName>` — where the baselines of
 * one Blocks stack/backend live. `backendHandlerPath` is resolved against the
 * working directory when relative (it is absolute in every template).
 */
export function baselineDir(backendHandlerPath: string, stackName: string): string {
	return join(dirname(resolve(backendHandlerPath)), 'baselines', stackName);
}

/**
 * Record that a block in `scope`'s stack reads the baseline at `file`, so the
 * stack-level check does not treat it as orphaned. Call it from the block's
 * constructor. A no-op outside a `BlocksStack` / `BlocksBackend`.
 *
 * @param scope - The block.
 * @param file - The baseline file the block reads and writes.
 */
export function claimBaseline(scope: Construct, file: string): void {
	findRoot(scope)?.claimed.add(resolve(file));
}

/**
 * Whether `scope`'s stack has an orphaned baseline, i.e. its synth fails. Call
 * it from a validation only (every block must have claimed by then). A block
 * uses it to hold back writing a *new* baseline in a synth that fails anyway:
 * after a rename, the renamed block's first baseline would otherwise be left
 * on disk and, once the old id is restored, be reported as orphaned itself.
 *
 * @param scope - Any construct in the stack.
 */
export function hasOrphanedBaselines(scope: Construct): boolean {
	const state = findRoot(scope);
	return state ? scan(state).some((f) => f.kind !== 'rebaselined') : false;
}

/** `file` relative to the working directory when it is inside it, else absolute. */
function display(file: string): string {
	const rel = relative(process.cwd(), file);
	return rel && !rel.startsWith('..') ? rel : file;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRemovalGuard(value: unknown): BaselineRemovalGuard | undefined {
	if (!isRecord(value)) return undefined;
	const { deletes, rebaselineEnv, runbook } = value;
	if (typeof deletes !== 'string' || typeof rebaselineEnv !== 'string' || typeof runbook !== 'string') {
		return undefined;
	}
	return { deletes, rebaselineEnv, runbook };
}

/** The variable names the file's block, exactly. A variable outside `BLOCKS_*` is never honoured. */
function rebaselineRequested(guard: BaselineRemovalGuard, fullId: string): boolean {
	if (!/^BLOCKS_[A-Z0-9_]+$/.test(guard.rebaselineEnv)) return false;
	return (process.env[guard.rebaselineEnv] ?? '')
		.split(',')
		.map((s) => s.trim())
		.includes(fullId);
}

/** Read-only: lists the stack's unclaimed baselines. Memoized per root. */
function scan(state: BaselineRoot): Finding[] {
	if (state.findings) return state.findings;
	const findings: Finding[] = [];
	const location = state.dir?.();
	if (location && existsSync(location.dir)) {
		for (const entry of readdirSync(location.dir).sort()) {
			if (!entry.endsWith('.json')) continue;
			const file = join(location.dir, entry);
			if (state.claimed.has(file)) continue;
			let value: unknown;
			try {
				value = JSON.parse(readFileSync(file, 'utf8'));
			} catch {
				findings.push({ kind: 'unreadable', file });
				continue;
			}
			if (!isRecord(value) || typeof value.fullId !== 'string') continue;
			const guard = parseRemovalGuard(value.removalGuard);
			if (!guard) continue;
			const fullId = value.fullId;
			findings.push({ kind: rebaselineRequested(guard, fullId) ? 'rebaselined' : 'orphan', file, fullId, guard });
		}
	}
	state.findings = findings;
	return findings;
}

function orphanMessage(stackName: string, fullId: string, file: string, guard: BaselineRemovalGuard): string {
	const env = `${guard.rebaselineEnv}=${fullId}`;
	return [
		`Blocks stack '${stackName}': no block with fullId '${fullId}' exists in this app any more, but its committed baseline`,
		`${display(file)} says it owns a stateful resource.`,
		`If you deploy this, CloudFormation will delete ${guard.deletes}.`,
		'',
		'Remedies:',
		`  • Renamed the block's id, or moved it under another scope? Restore the old id, so its fullId is '${fullId}' again.`,
		`    Keeping the resource under a new id needs a CloudFormation resource import: see ${guard.runbook}.`,
		"  • Removing it on purpose? Restore the block first with `removalPolicy: 'retain'` and deploy, so CloudFormation",
		'    keeps the resource (detached from the stack, orphaned) when the block goes. Then remove the block and re-baseline.',
		`  • Re-baseline deliberately: ${env} <your synth/deploy command>. This deletes the baseline file; commit the deletion.`,
	].join('\n');
}

/**
 * Fail synth for every baseline under `root`'s directory that guards a
 * stateful resource and that no block in this stack/backend claims. Called
 * once from the `BlocksStack` / `BlocksBackend` constructor, so it is on even
 * when the app contains no block that writes baselines. Runs as a construct
 * validation, i.e. after the whole app has been constructed.
 *
 * Only this stack's directory is read, so another stack's baselines never
 * trigger it.
 *
 * @internal
 */
export function addOrphanedBaselineCheck(root: Construct, backendHandlerPath: string, stackName: () => string): void {
	const state: BaselineRoot = { claimed: new Set() };
	(root as unknown as Record<symbol, BaselineRoot>)[ROOT_KEY] = state;
	if (typeof backendHandlerPath !== 'string' || backendHandlerPath.length === 0) return;
	state.dir = () => {
		const name = stackName();
		return { dir: baselineDir(backendHandlerPath, name), stackName: name };
	};
	root.node.addValidation({
		validate: () => {
			const name = stackName();
			const errors: string[] = [];
			for (const finding of scan(state)) {
				switch (finding.kind) {
					case 'unreadable':
						errors.push(
							`Blocks stack '${name}': the baseline ${display(finding.file)} cannot be read, so it cannot be checked. ` +
								'Restore it from version control (or delete it if no block of this stack wrote it).',
						);
						break;
					case 'orphan':
						errors.push(orphanMessage(name, finding.fullId, finding.file, finding.guard));
						break;
					case 'rebaselined':
						if (!existsSync(finding.file)) break;
						unlinkSync(finding.file);
						cdk.Annotations.of(root).addInfoV2(
							'@aws-blocks/core:BaselineRemoved',
							`${finding.guard.rebaselineEnv} named '${finding.fullId}', which no longer exists in this app: deleted its ` +
								`baseline ${display(finding.file)}. Commit the deletion. CloudFormation will delete ${finding.guard.deletes} ` +
								"on the next deploy unless its removal policy was 'retain'.",
						);
						break;
				}
			}
			return errors;
		},
	});
}
