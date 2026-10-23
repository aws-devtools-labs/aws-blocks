// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Checks that every stack a CI-deployed test app creates can be reclaimed by
// cleanup-stacks.yml when its own teardown fails: the stack name starts with a
// prefix the sweeper lists (and the cleanup role in test-infra may delete), and
// every stack carries a blocks:purpose tag the sweeper accepts. A test app
// outside those prefixes leaks its stacks for good, since each run deploys a
// fresh name that no later run destroys.
//
// Static: it reads the sources, so it needs no build and no AWS access.
// Scaffolded template apps (my-app-*) are named by create-blocks-app, not here.
//
// Run: node --test scripts/ci/e2e-stack-prefixes.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const CLEANUP = read('.github/workflows/cleanup-stacks.yml');
const OIDC = read('test-infra/github-oidc-stack.ts');

// Deployed test apps that are not standalone CDK apps, so they name no stack.
const NOT_STANDALONE = {
	'amplify-gen2': 'Amplify names the sandbox stacks; the Amplify step of cleanup-stacks.yml sweeps them',
};

// The prefixes in `for PREFIX in ...; do` (the stack sweep and the DELETE_FAILED count).
function sweptPrefixes() {
	const lists = [...CLEANUP.matchAll(/for PREFIX in ([^;]+); do/g)].map((m) => m[1].trim().split(/\s+/).sort());
	assert.ok(lists.length >= 2, 'cleanup-stacks.yml lost its stack-prefix loops');
	for (const list of lists) assert.deepEqual(list, lists[0], 'the stack-prefix loops in cleanup-stacks.yml differ');
	return lists[0];
}

// Each top-level string or template literal in a TS expression, with its
// leading static text: for `a ? \`bb-x-${id}\` : 'bb-y'` the prefixes are
// ['bb-x-', 'bb-y']. Literals nested inside `${...}` are part of their parent.
function topLevelLiterals(expr) {
	const out = [];
	let i = 0;
	while (i < expr.length) {
		const q = expr[i];
		if (q !== '`' && q !== "'" && q !== '"') {
			i++;
			continue;
		}
		let j = i + 1;
		let prefix = '';
		let inPrefix = true;
		while (j < expr.length && expr[j] !== q) {
			if (expr[j] === '\\') {
				j += 2;
				continue;
			}
			if (q === '`' && expr[j] === '$' && expr[j + 1] === '{') {
				inPrefix = false;
				let depth = 1;
				j += 2;
				while (j < expr.length && depth > 0) {
					if (expr[j] === '{') depth++;
					else if (expr[j] === '}') depth--;
					else if (expr[j] === '`') j = expr.indexOf('`', j + 1);
					j++;
				}
				continue;
			}
			if (inPrefix) prefix += expr[j];
			j++;
		}
		out.push({ prefix, body: expr.slice(i + 1, j) });
		i = j + 1;
	}
	return out;
}
const literalPrefixes = (expr) => topLevelLiterals(expr).map((l) => l.prefix);

// Test apps a workflow runs: named in a workflow, or in a root npm script a
// workflow runs (following `npm run` chains).
function deployedApps() {
	const scripts = JSON.parse(read('package.json')).scripts;
	const workflows = readdirSync(join(ROOT, '.github/workflows'))
		.filter((f) => /\.ya?ml$/.test(f))
		.map((f) => read(`.github/workflows/${f}`))
		.join('\n');
	const apps = new Set();
	const seen = new Set();
	const visit = (text) => {
		for (const m of text.matchAll(/test-apps\/([\w-]+)/g)) apps.add(m[1]);
		for (const m of text.matchAll(/npm run ([\w:.-]+)/g)) {
			if (seen.has(m[1]) || !scripts[m[1]]) continue;
			seen.add(m[1]);
			visit(scripts[m[1]]);
		}
	};
	visit(workflows);
	return [...apps].filter((app) => existsSync(join(ROOT, 'test-apps', app, 'aws-blocks', 'index.cdk.ts'))).sort();
}

describe('cleanup prefixes', () => {
	it('match the prefixes the cleanup role may delete', () => {
		const block = OIDC.match(/const E2E_PREFIXES = \[([^\]]*)\]/);
		assert.ok(block, 'E2E_PREFIXES not found in test-infra/github-oidc-stack.ts');
		const iam = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
		assert.deepEqual(sweptPrefixes(), iam);
	});

	it('match the REST API and IAM role sweeps', () => {
		const roles = CLEANUP.match(/test\("\^\(([^)]+)\)"\)/);
		assert.ok(roles, 'the IAM role prefix regex is missing from cleanup-stacks.yml');
		assert.deepEqual(roles[1].split('|').sort(), sweptPrefixes());
		const apis = CLEANUP.match(/case "\$NAME" in\n\s*([^\n]+)\) ;;/);
		assert.ok(apis, 'the REST API name patterns are missing from cleanup-stacks.yml');
		const patterns = apis[1].split('|').map((p) => p.trim());
		for (const prefix of sweptPrefixes()) assert.ok(patterns.includes(`${prefix}*`), `REST API sweep misses ${prefix}*`);
	});

	it('still accept e2e-* and *-e2e purpose tags', () => {
		assert.match(CLEANUP, /^\s*e2e-\* \| \*-e2e\) ;;$/m);
	});
});

describe('deployed test apps', () => {
	const apps = deployedApps();

	it('are found', () => {
		for (const app of ['comprehensive', 'compute-smoke', 'vpc-smoke', 'telemetry', 'native-bindings', 'hosting-spa']) {
			assert.ok(apps.includes(app), `${app} not found among the deployed test apps: ${apps.join(', ')}`);
		}
	});

	for (const app of apps) {
		const file = `test-apps/${app}/aws-blocks/index.cdk.ts`;
		const src = read(file);

		if (app in NOT_STANDALONE) {
			it(`${app} names no stack of its own`, () => {
				assert.doesNotMatch(src, /BlocksStack\.create\(|new (cdk\.)?Stack\(/, NOT_STANDALONE[app]);
			});
			continue;
		}

		it(`${app} names its stacks under a swept prefix`, () => {
			const m = src.match(/const stackName =([\s\S]*?);\n/);
			assert.ok(m, `${file}: no \`const stackName = ...;\` (list the app in NOT_STANDALONE if it names no stack)`);
			const names = literalPrefixes(m[1]);
			assert.ok(names.length > 0, `${file}: stackName has no string literal`);
			const prefixes = sweptPrefixes();
			for (const name of names) {
				assert.ok(
					prefixes.some((p) => name.startsWith(p)),
					`${file}: stack name '${name}...' starts with none of the swept prefixes ${prefixes.join(' ')}`,
				);
			}
			// Extra stacks (e.g. `${stackName}-vpc-ref`) must extend stackName.
			for (const s of src.matchAll(/new (?:cdk\.)?Stack\(\s*\w+,\s*([^,]+),/g)) {
				assert.match(s[1], /^`\$\{stackName\}/, `${file}: extra stack ${s[1]} does not start with \${stackName}`);
			}
		});

		it(`${app} tags every stack with an e2e blocks:purpose`, () => {
			const tags = [...src.matchAll(/Tags\.of\((\w+)\)\.add\(\s*'blocks:purpose',\s*'([^']+)'/g)];
			assert.ok(tags.length > 0, `${file}: no blocks:purpose tag`);
			for (const [, , value] of tags) {
				assert.match(value, /^e2e-|-e2e$/, `${file}: blocks:purpose '${value}' is not e2e-* or *-e2e`);
			}
			// A second stack is only tagged when the tag goes on the whole app.
			if (/new (cdk\.)?Stack\(/.test(src)) {
				assert.ok(
					tags.some(([, target]) => target === 'app'),
					`${file}: creates extra stacks, so tag blocks:purpose with cdk.Tags.of(app)`,
				);
			}
		});
	}
});

// A cancelled, timed-out or crashed job never runs the suite's own destroy, so
// the job's last steps delete what the checkout deployed. Compute Smoke needs
// it most: a leaked stack keeps its VPC endpoints in the shared compute test
// VPC and every later run in that account fails to deploy.
describe('pr-checks.yml e2e-compute-smoke', () => {
	const yml = read('.github/workflows/pr-checks.yml');
	const job = yml.split(/^(?=  [a-z][\w-]*:$)/m).find((block) => block.startsWith('  e2e-compute-smoke:'));
	const steps = job.slice(job.indexOf('    steps:\n')).split(/^(?=      - )/m).slice(1);
	const ifOf = (step) => step.match(/^ {8}if: (.+)$/m)?.[1];
	const minutes = (step) => Number(step.match(/timeout-minutes: (\d+)/)?.[1]);
	const guard = "always() && hashFiles('test-apps/compute-smoke/.blocks-sandbox/sandbox-id.txt') != ''";

	it('ends with a bounded always() teardown of the stacks it deployed', () => {
		const [refresh, teardown] = steps.slice(-2);
		assert.match(refresh, /uses: \.\/\.github\/actions\/e2e-aws-credentials\n/);
		assert.equal(ifOf(refresh), guard);
		assert.match(teardown, /run: node scripts\/ci\/e2e-teardown\.mjs test-apps\/compute-smoke\n/);
		assert.equal(ifOf(teardown), guard);
		assert.match(teardown, /JOB_STATUS: \$\{\{ job\.status \}\}/);
		assert.doesNotMatch(teardown, /continue-on-error/);
		// GitHub force-stops a cancelled job 5 minutes after the cancel.
		assert.ok(minutes(refresh) >= 1 && minutes(teardown) >= 1, 'both teardown steps need timeout-minutes');
		assert.ok(minutes(refresh) + minutes(teardown) <= 4, 'the teardown steps may take at most 4 minutes together');
	});

	it('names every stack with the sandbox id the teardown matches', () => {
		const src = read('test-apps/compute-smoke/aws-blocks/index.cdk.ts');
		assert.match(src, /const id = getSandboxId\(projectRoot\);/);
		const m = src.match(/const stackName =([\s\S]*?);\n/);
		// One top-level literal per mode (sandbox, production), each with ${id}.
		assert.equal(literalPrefixes(m[1]).length, 2);
		// The teardown matches the id as a dash-delimited token.
		assert.equal(m[1].match(/-\$\{id\}(?=\$\{|-|`)/g)?.length, 2, 'both stack names must contain -${id} as a token');
		assert.match(src, /new cdk\.Stack\(app, `\$\{stackName\}-vpc-ref`/);
	});

	// The FileBucket is named `<stackName>-compute-smoke-artifacts` and S3 caps
	// bucket names at 63 characters, so a long PR number or attempt would fail
	// the synth.
	it('keeps the longest stack name within the bucket-name limit', () => {
		const src = read('test-apps/compute-smoke/aws-blocks/index.cdk.ts');
		const app = read('test-apps/compute-smoke/aws-blocks/index.ts');
		assert.match(app, /new Scope\('compute-smoke'\)/);
		assert.match(app, /new FileBucket\(scope, 'artifacts'\)/);
		assert.match(src, /const MAX_STACK_NAME_LENGTH = 63 - '-compute-smoke-artifacts'\.length;/);
		assert.match(src, /if \(stackName\.length > MAX_STACK_NAME_LENGTH\) \{\n\s*throw /);
		const max = 63 - '-compute-smoke-artifacts'.length;
		assert.match(src, /randomUUID\(\)\.slice\(0, 8\)/);
		// The job only runs on pull requests: a 4-digit PR number, a 2-digit attempt.
		assert.match(job.match(/^ {4}if: (.+)$/m)?.[1] ?? '', /github\.event\.pull_request\.head\.repo\.full_name ==/);
		const env = job.match(/^ {6}BLOCKS_STACK_SUFFIX: (.+)$/m)?.[1];
		assert.ok(env, 'e2e-compute-smoke sets no BLOCKS_STACK_SUFFIX');
		const ciSuffix = env
			.replace('${{ github.event.pull_request.number || github.run_id }}', '9999')
			.replace('${{ github.run_attempt }}', '99');
		assert.doesNotMatch(ciSuffix, /\$\{\{/, `unexpected BLOCKS_STACK_SUFFIX shape: ${env}`);
		const expand = (body, sfx) =>
			body
				.replace('${id}', 'x'.repeat(8))
				.replace("${suffix ? `-${suffix}` : ''}", sfx ? `-${sfx}` : '')
				.replace("${suffix || 'default'}", sfx || 'default');
		const [sandbox, production] = topLevelLiterals(src.match(/const stackName =([\s\S]*?);\n/)[1]).map((l) => l.body);
		// CI deploys sandbox mode only; production mode runs locally, without a suffix.
		for (const name of [expand(sandbox, ciSuffix), expand(production, '')]) {
			assert.doesNotMatch(name, /\$\{/, `unexpected interpolation in ${name}`);
			assert.ok(name.length <= max, `${name} is ${name.length} characters, over ${max}`);
		}
	});

	// The teardown returns once each delete is accepted, and the job's end
	// releases the per-account lock. The next run must not deploy its private-DNS
	// endpoints while the last run's are still being deleted, or still being
	// created after a cancel.
	it("waits for an earlier run's stacks to finish deleting before it deploys", () => {
		const at = (name) => steps.findIndex((s) => s.includes(`- name: ${name}\n`));
		const deploy = at('E2E Compute Smoke');
		const wait = steps.findIndex((s) => /DELETE_IN_PROGRESS/.test(s));
		assert.ok(wait > 0 && wait < deploy, 'no DELETE_IN_PROGRESS wait before E2E Compute Smoke');
		for (const state of ['CREATE_IN_PROGRESS', 'ROLLBACK_IN_PROGRESS', 'DELETE_IN_PROGRESS']) {
			assert.match(steps[wait], new RegExp(`stacks [A-Z_ \\\\\n]*\\b${state}\\b`), `the wait misses ${state}`);
		}
		const credentials = steps.findIndex((s) => s.includes('uses: ./.github/actions/e2e-aws-credentials'));
		assert.ok(credentials < wait, 'the wait must come after the credentials step');
		const src = read('test-apps/compute-smoke/aws-blocks/index.cdk.ts');
		const prefix = steps[wait].match(/starts_with\(StackName, '([^']+)'\)/)?.[1];
		assert.ok(prefix, 'the wait must filter stacks with starts_with(StackName, ...)');
		// Exactly the app's own prefix: a wider one would wait on other suites' stacks.
		const names = literalPrefixes(src.match(/const stackName =([\s\S]*?);\n/)[1]);
		const common = names.reduce((a, b) => {
			let n = 0;
			while (n < a.length && a[n] === b[n]) n++;
			return a.slice(0, n);
		});
		assert.equal(prefix, common, `the wait's prefix '${prefix}' is not the stack names' '${common}'`);
		assert.ok(minutes(steps[wait]) >= 1 && minutes(steps[wait]) <= 12, 'the wait needs a timeout-minutes of at most 12');
		assert.equal(ifOf(steps[wait]), undefined, 'the wait runs only when the job reaches it');
		// With permanent endpoints (no lock, no per-stack endpoints) it must not
		// wait on other runs' stacks.
		assert.match(steps[wait], /if grep -q BlocksComputeTestVpcEndpoints test-infra\/vpc-test-stack\.ts; then\n.*\n\s*exit 0\n/);
		assert.ok(steps[wait].indexOf('exit 0') < steps[wait].indexOf('while :'), 'the guard must come before the wait loop');
	});
});
