// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard: the RPC error metric's CloudWatch namespace is ONE name, and
 * every place a customer reads it has to say the same thing.
 *
 * `CDKBlocks` is the namespace a failed RPC call writes in its EMF line, so it is
 * the name a customer types into an alarm or a dashboard. It is published in three
 * places that cannot see each other: the exported constant, the EMF directive the
 * handler actually writes, and the metric table in `README.md`. A rename that moves
 * the constant and leaves the table behind compiles clean and passes every existing
 * test, and the customer alarms on a namespace nothing writes — the failure is
 * silent on both sides, because an alarm on an unwritten namespace just never fires.
 *
 * So this guard checks three directions:
 *
 *  1. PINNED — the constant is the current name ({@link CURRENT}). This is the
 *     assertion a rename has to come and update deliberately.
 *  2. AGREEMENT — the namespace in the EMF line the code really produces, and the
 *     one the README documents, both equal the constant. These two hold across any
 *     future rename and are the drift guards: they fail the moment the three
 *     populations disagree, whatever the name happens to be.
 *  3. NEGATIVE — no stale `AWSBlocks` literal survives on the RPC-metric surface.
 *
 * `AWSBlocks` is NOT dead text repo-wide: it is also the key inside the
 * `Metadata.AWSToolsMetrics` CloudFormation template entry
 * (`cdk/stack-metadata.ts`), which is a different mechanism with its own opt-out
 * and is deliberately NOT renamed — see {@link TEMPLATE_METADATA_KEY_IS_UNCHANGED}.
 * That is why the negative scan is scoped to the RPC-metric files and the README
 * section that documents them, rather than being a repo-wide sweep for the word.
 *
 * Run: node --test dist/rpc-error-metric-namespace.test.js
 */
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RPC_ERROR_METRIC_NAMESPACE, rpcErrorMetricLine } from './rpc-error-metric.js';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(pkgRoot, '..', '..');

/** The CloudWatch namespace this repo publishes the RPC error metric under now. */
const CURRENT = 'CDKBlocks';

/** The namespace it was renamed FROM. Spelled in pieces so this file is not itself a hit. */
const LEGACY = `AWS${'Blocks'}`;

/** `path` (repo-relative) read as UTF-8, or null when it is not a readable text file. */
function readText(path: string): string | null {
	try {
		return readFileSync(join(repoRoot, path), 'utf-8');
	} catch {
		return null;
	}
}

test('the exported namespace constant is the current name', () => {
	assert.strictEqual(
		RPC_ERROR_METRIC_NAMESPACE,
		CURRENT,
		`RPC_ERROR_METRIC_NAMESPACE is ${JSON.stringify(RPC_ERROR_METRIC_NAMESPACE)}, not ${JSON.stringify(CURRENT)}.\n` +
			`This is the CloudWatch namespace customers alarm on. If you are renaming it on purpose, update CURRENT\n` +
			`in this file and every site the other assertions below name, in the same commit.`,
	);
});

test('the EMF line the code really writes carries the namespace constant', () => {
	const line = JSON.parse(rpcErrorMetricLine({ status: 500, namespace: 'api', method: 'crash' }, 'fn', 0));
	const namespaces = line._aws.CloudWatchMetrics.map((directive: { Namespace: string }) => directive.Namespace);

	assert.deepStrictEqual(
		namespaces,
		[RPC_ERROR_METRIC_NAMESPACE],
		`The EMF directive names ${JSON.stringify(namespaces)} but the constant is ` +
			`${JSON.stringify(RPC_ERROR_METRIC_NAMESPACE)}.\n` +
			`CloudWatch reads the wire format, not the constant, so a literal hardcoded into the directive is what\n` +
			`customers would actually get. Build the directive from RPC_ERROR_METRIC_NAMESPACE.`,
	);
});

/** The README section that documents this metric, and nothing after it. */
function readmeMonitoringSection(): string {
	const readme = readFileSync(join(pkgRoot, 'README.md'), 'utf-8');
	const start = readme.indexOf('#### Monitoring failed RPC calls');
	assert.notStrictEqual(
		start,
		-1,
		'the "Monitoring failed RPC calls" section is missing from packages/core/README.md',
	);
	const rest = readme.slice(start);
	const end = rest.indexOf('\n### ');
	return end === -1 ? rest : rest.slice(0, end);
}

test('the README documents the namespace the code emits', () => {
	const documented = readmeMonitoringSection().match(/^\| Namespace \| `([^`]+)` \|$/m);

	assert.ok(documented, 'the metric table in packages/core/README.md has no "| Namespace | `...` |" row');
	assert.strictEqual(
		documented[1],
		RPC_ERROR_METRIC_NAMESPACE,
		`README documents the namespace as ${JSON.stringify(documented[1])} but the code emits ` +
			`${JSON.stringify(RPC_ERROR_METRIC_NAMESPACE)}.\n` +
			`The table is where a customer copies the name from, so a stale row points every alarm at a namespace\n` +
			`nothing writes — and an alarm on an unwritten namespace fails silently, by never firing.`,
	);
});

/**
 * The RPC-metric surface: the files that must not name the legacy namespace once the
 * rename is done. The pending changeset is included while it exists — it is the
 * release note that first announces the metric, so it has to announce the name
 * customers will actually get. It disappears when `changeset version` consumes it,
 * which is why its absence is not a failure.
 */
const RPC_METRIC_SURFACE: readonly string[] = [
	'packages/core/src/rpc-error-metric.ts',
	'packages/core/src/rpc-error-metric.test.ts',
	'.changeset/core-rpc-error-metric.md',
];

test('no stale legacy namespace survives on the RPC-metric surface', () => {
	const offenders: string[] = [];

	for (const path of RPC_METRIC_SURFACE) {
		const text = readText(path);
		// A consumed changeset is gone, not broken; a missing source file is caught by the compiler.
		if (text === null) {
			if (!existsSync(join(repoRoot, path))) continue;
			offenders.push(`${path}: exists but could not be read as text`);
			continue;
		}
		for (const [i, line] of text.split('\n').entries())
			if (line.includes(LEGACY)) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
	}

	for (const [i, line] of readmeMonitoringSection().split('\n').entries())
		if (line.includes(LEGACY))
			offenders.push(`packages/core/README.md (monitoring section) +${i + 1}: ${line.trim()}`);

	assert.deepStrictEqual(
		offenders,
		[],
		`${offenders.length} reference(s) still name the legacy metric namespace "${LEGACY}":\n\n` +
			`${offenders.join('\n')}\n\n` +
			`The namespace is now "${CURRENT}". These sites are prose and test literals that no compiler reaches,\n` +
			`so a partial rename is invisible until a customer's alarm never fires.\n`,
	);
});

/**
 * The CloudFormation template metadata key is a SEPARATE mechanism and is deliberately
 * left as `AWSBlocks`, so this guard pins it rather than sweeping it:
 *
 * - it is not a CloudWatch namespace at all — it is a key inside
 *   `Metadata.AWSToolsMetrics` in the synthesized template, read by template
 *   consumers rather than by CloudWatch;
 * - `AWSToolsMetrics` is a shared AWS-tooling convention, not our branding, and the
 *   consumers of our slot inside it are outside this repo and were not verified here;
 * - it has its own switch, `CDK_BLOCKS_DISABLE_TEMPLATE_METADATA`, which is what the
 *   rebrand changed in this same file while leaving the key itself alone.
 *
 * Renaming it is a separate decision with a separate blast radius. If that decision is
 * taken, update this assertion in that commit.
 */
const TEMPLATE_METADATA_KEY_IS_UNCHANGED = `const BLOCKS_TOOLS_METRICS_KEY = '${LEGACY}';`;

test('the CloudFormation template metadata key is left out of this rename', () => {
	const source = readText('packages/core/src/cdk/stack-metadata.ts') ?? '';

	assert.ok(
		source.includes(TEMPLATE_METADATA_KEY_IS_UNCHANGED),
		`packages/core/src/cdk/stack-metadata.ts no longer declares ${JSON.stringify(TEMPLATE_METADATA_KEY_IS_UNCHANGED)}.\n` +
			`That key is the app's slot in the shared AWSToolsMetrics template metadata, not the CloudWatch namespace,\n` +
			`and its consumers live outside this repo. It was held out of the metric-namespace rename on purpose.\n` +
			`If you are renaming it deliberately, say so in the changeset and update this assertion.`,
	);
});
