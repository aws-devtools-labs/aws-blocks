// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Repo invariant: a Building Block's local mock and AWS runtime must enforce
 * the same input validation and error contract.
 *
 * Validation that lives only in `index.mock.ts` lets local tests pass while the
 * deployed path accepts the same input (or fails with a raw SDK error instead
 * of the named, branded one). Validation that lives only in `index.aws.ts`
 * lets local development accept input that fails once deployed. Both drift
 * silently, because no single test exercises the two entries side by side.
 *
 * For every BB that has both `src/index.mock.ts` and `src/index.aws.ts`, this
 * source scan requires:
 *
 *  1. `src/parity.test.ts` — a table of cases run against the mock and against
 *     the AWS entry with the SDK stubbed, asserting the same named error or
 *     success (and, for success, the captured SDK input). See
 *     `packages/bb-file-bucket/src/parity.test.ts` for the model.
 *  2. If `src/validation.ts` exists, both `index.mock.ts` and `index.aws.ts`
 *     import it, so shared validation is called from both entries.
 *
 * A mock that only re-exports the AWS entry's classes runs the same code, so it
 * meets both rules by construction.
 *
 * BBs that don't meet a rule yet are listed in {@link PARITY_ALLOWLIST} with a
 * reason or the open pull request that owns the change. An allowlist entry
 * that no longer applies fails this test, so the list only shrinks.
 *
 * This is a structural check: it proves the suite and the shared module exist,
 * not that every check is covered. The per-BB `parity.test.ts` proves behavior.
 *
 * Run: node --test dist/mock-aws-parity.test.js
 */

type Rule = 'paritySuite' | 'sharedValidation';

/**
 * The one place a BB may be exempted from a rule. Every entry says why, and
 * names the owning pull request when one is open.
 */
const PARITY_ALLOWLIST: Record<string, Partial<Record<Rule, string>>> = {
	'bb-agent': {
		paritySuite:
			'Follow-up: both entries share AgentBase validation; the AWS dispatch adds a request schema and session-id limit the mock lacks. Open PR #1376 changes agent.ts and agent.aws.ts.',
	},
	'bb-async-job': { paritySuite: 'Open PR #432 adds delaySeconds validation to both entries; add the suite with or after it.' },
	'bb-auth-oidc': {
		paritySuite: 'Follow-up: option validation is shared; an http: issuer is accepted locally but fails on AWS. Open PRs #1414 and #1313 change this BB.',
	},
	'bb-cron-job': { paritySuite: 'No runtime methods; schedules are checked at synth. Open PRs #686, #688 and #1346 change the local mock.' },
	'bb-dashboard': { paritySuite: 'No runtime methods that take caller input.' },
	'bb-data': { paritySuite: 'Follow-up: query validation is shared (database.ts, rls.ts); parameter marshalling differs per engine. RLS work is in flight.' },
	'bb-database': { paritySuite: 'Open PRs #716, #1386 and #1432 rewrite both entries.' },
	'bb-distributed-data': {
		paritySuite: 'Follow-up: the mock simulates DSQL statement rules that AWS leaves to the service, under different error names.',
	},
	'bb-knowledge-base': { paritySuite: 'Follow-up: retrieve() filter values are not validated the same way. Open PR #427 changes index.mock.ts.' },
	'bb-secret': { paritySuite: 'Follow-up: get() version handles and put() values differ. Open PRs #844, #1116 and #1412 change both entries.' },
	'bb-tracer': { paritySuite: 'Follow-up: samplingRate is range-checked by the mock only. Open PR #1322 changes index.mock.ts.' },
};

const packagesDir = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'packages');

/** BBs that ship both a local mock and an AWS runtime entry. */
function dualEntryBlocks(): string[] {
	return readdirSync(packagesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && d.name.startsWith('bb-'))
		.map((d) => d.name)
		.filter(
			(name) =>
				existsSync(join(packagesDir, name, 'src', 'index.mock.ts')) &&
				existsSync(join(packagesDir, name, 'src', 'index.aws.ts')),
		)
		.sort();
}

/**
 * True when `index.mock.ts` only re-exports the AWS entry's classes and declares
 * no implementation of its own (bb-logger, bb-metrics, the compute BBs). The two
 * entries then run the same code, so parity holds by construction.
 */
function mockReusesAwsEntry(mockSource: string): boolean {
	const code = mockSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	return /\bfrom\s+['"]\.\/index\.aws\.js['"]/.test(code) && !/\b(class|function)\s+\w/.test(code);
}

/** True when `source` imports or re-exports from `./validation.js`. */
function importsValidation(source: string): boolean {
	return /\bfrom\s+['"]\.\/validation\.js['"]/.test(source) || /\bimport\s*\(\s*['"]\.\/validation\.js['"]\s*\)/.test(source);
}

/** The rules a BB currently violates, ignoring the allowlist. */
function violations(name: string): Partial<Record<Rule, string>> {
	const src = join(packagesDir, name, 'src');
	const out: Partial<Record<Rule, string>> = {};
	if (mockReusesAwsEntry(readFileSync(join(src, 'index.mock.ts'), 'utf-8'))) return out;
	if (!existsSync(join(src, 'parity.test.ts'))) {
		out.paritySuite = `${name} has index.mock.ts and index.aws.ts but no src/parity.test.ts`;
	}
	if (existsSync(join(src, 'validation.ts'))) {
		const mock = importsValidation(readFileSync(join(src, 'index.mock.ts'), 'utf-8'));
		const aws = importsValidation(readFileSync(join(src, 'index.aws.ts'), 'utf-8'));
		if (mock !== aws) {
			out.sharedValidation = `${name}/src/validation.ts is imported by ${mock ? 'index.mock.ts' : 'index.aws.ts'} only`;
		}
	}
	return out;
}

describe('mock and AWS entries enforce the same validation', () => {
	const blocks = dualEntryBlocks();

	test('discovers the Building Blocks that have both entries', () => {
		// Guard the discovery itself so a path change can't make every check vacuous.
		assert.ok(blocks.length >= 10, `expected at least 10 dual-entry BBs, found ${blocks.length}`);
		assert.ok(blocks.includes('bb-file-bucket'));
	});

	for (const name of blocks) {
		test(name, () => {
			const found = violations(name);
			const allowed = PARITY_ALLOWLIST[name] ?? {};
			const unexpected = (Object.keys(found) as Rule[]).filter((rule) => !allowed[rule]).map((rule) => found[rule]);
			assert.deepStrictEqual(
				unexpected,
				[],
				'Add the missing piece (see docs/reference/building-block-structure.md#mock-and-aws-validation-parity), ' +
					'or, if it is owned elsewhere, add an entry with a reason to PARITY_ALLOWLIST.',
			);
		});
	}

	test('every allowlist entry is still needed and has a reason', () => {
		const stale: string[] = [];
		for (const [name, rules] of Object.entries(PARITY_ALLOWLIST)) {
			if (!blocks.includes(name)) {
				stale.push(`${name}: not a BB with both index.mock.ts and index.aws.ts`);
				continue;
			}
			const found = violations(name);
			for (const [rule, reason] of Object.entries(rules) as [Rule, string][]) {
				if (!reason.trim()) stale.push(`${name}.${rule}: empty reason`);
				if (!found[rule]) stale.push(`${name}.${rule}: now satisfied — remove the allowlist entry`);
			}
		}
		assert.deepStrictEqual(stale, []);
	});
});

describe('mockReusesAwsEntry', () => {
	test('recognizes a mock that only re-exports the AWS entry', () => {
		assert.ok(mockReusesAwsEntry("// a mock\nassertNotMockInDeployedEnv('bb-x');\nexport { X } from './index.aws.js';"));
		assert.ok(mockReusesAwsEntry("export * from './index.aws.js';\nexport type { T } from './types.js';"));
	});

	test('does not exempt a mock with its own implementation', () => {
		assert.ok(!mockReusesAwsEntry("import { X } from './index.aws.js';\nexport class Y extends X {}"));
		assert.ok(!mockReusesAwsEntry("export { X } from './index.aws.js';\nexport function put() {}"));
		assert.ok(!mockReusesAwsEntry('export class X {}'));
	});
});

describe('importsValidation', () => {
	test('matches static imports, re-exports and dynamic imports of ./validation.js', () => {
		assert.ok(importsValidation("import { a } from './validation.js';"));
		assert.ok(importsValidation('import {\n\ta,\n\tb,\n} from "./validation.js";'));
		assert.ok(importsValidation("export { a } from './validation.js';"));
		assert.ok(importsValidation("const v = await import('./validation.js');"));
	});

	test('ignores comments that only mention the file, and other modules', () => {
		assert.ok(!importsValidation('// see validation.ts'));
		assert.ok(!importsValidation("import { a } from './key-validation.js';"));
		assert.ok(!importsValidation("import { a } from '../validation.js';"));
	});
});
