// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalog validation — the structural rules every case must meet before it can
 * run or be scored. Runs in CI (`parity validate-catalog`) and is the gate an
 * LLM-proposed case must pass before review.
 */

import type { ParityCase } from './types.js';

// Segments after the pack may carry method names verbatim (`putBatch`, `getUrl`).
const ID_SHAPE = /^[a-z0-9]+(\.[A-Za-z0-9-]+){2,}$/;
const CATEGORIES = new Set(['limits', 'errors', 'consistency', 'async', 'security']);

export interface CatalogProblem {
	caseId: string;
	problem: string;
}

/** Every problem in `cases`, given the packs a stack has runners for. Empty means valid. */
export function validateCatalog(cases: readonly ParityCase[], knownPacks: readonly string[]): CatalogProblem[] {
	const problems: CatalogProblem[] = [];
	const seen = new Set<string>();
	const packs = new Set(knownPacks);
	for (const c of cases) {
		const add = (problem: string) => problems.push({ caseId: c.id, problem });
		if (seen.has(c.id)) add('duplicate id');
		seen.add(c.id);
		if (!ID_SHAPE.test(c.id)) add('id must be at least three dot-separated segments: <pack>.<capability>.<entry point>…');
		if (!c.id.startsWith(`${c.pack}.`)) add(`id must start with its pack "${c.pack}."`);
		if (!packs.has(c.pack)) add(`no runner registered for pack "${c.pack}"`);
		if (!c.block.startsWith('bb-') && c.block !== 'core') add('block must be a bb-* package name or "core"');
		if (!CATEGORIES.has(c.category)) add(`unknown category "${c.category}"`);
		if (!c.description.trim()) add('description is empty');
		if (!/https?:\/\/|README|DESIGN|RFC/.test(c.source)) add('source must cite an AWS doc URL, an RFC, or a README/DESIGN.md line');
		if (c.sweep) {
			const { param, min, max, documented } = c.sweep;
			if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || min > max) add('sweep range must be integers with 0 ≤ min ≤ max');
			if (!param) add('sweep param is empty');
			if (documented !== undefined && (documented < min || documented > max)) add('sweep.documented must lie inside [min, max]');
		}
	}
	return problems;
}
