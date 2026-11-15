// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Repo invariant for .github/workflows/*.yml and composite actions: a `${{ }}`
// expression inside a `run:` script (or an actions/github-script `script:`) is
// expanded into the script text before the shell or Node parses it, so a value
// a contributor can influence (a branch name, a step output derived from repo
// content, an input, a dynamic matrix entry) becomes code. Pass such values
// through `env:` and quote them as shell variables ("$VERSION"). A heredoc in a
// `run:` script uses a quoted delimiter (<<'EOF'), so its body isn't expanded.
// That heredoc rule is hygiene, not a sink: an unquoted heredoc that only
// expands env vars is safe (the shell doesn't re-parse an expanded value, and a
// `${{ }}` inside one is already caught by the expression rule). It keeps every
// body literal so a reader never has to check which case a heredoc is; passing
// values through `env:` stays the safe pattern.
//
// Contexts that carry no contributor text (run ids, the commit SHA, the event
// name, runner paths, job results, a static matrix) are allowed inline.
// Allowlist entries are exact file:line with a reason; an entry that stops
// matching a site fails the test, so the list only shrinks.
//
// Run: node --test scripts/sink-guards/workflows.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareWithAllowlist, findWorkflowSinks, listWorkflowFiles, report, scan } from './sinks.mjs';

const REVERT_RELEASE = 'Covered by open PR #520 (harden revert-release.yml against script injection), which owns this file.';

const ALLOWLIST = [
	{ at: '.github/workflows/revert-release.yml:35', reason: REVERT_RELEASE },
	{ at: '.github/workflows/revert-release.yml:64', reason: REVERT_RELEASE },
	{ at: '.github/workflows/revert-release.yml:67', reason: REVERT_RELEASE },
];

const workflow = (steps, extra = '') =>
	['on: push', 'jobs:', '  build:', '    runs-on: ubuntu-latest', extra, '    steps:', ...steps].filter(Boolean).join('\n');

describe('workflow sink detector', () => {
	const find = (yaml) => findWorkflowSinks('w.yml', yaml).map((f) => `${f.line}:${f.kind}`);

	it('flags contributor-controlled contexts inside run:', () => {
		const yaml = workflow([
			'      - run: echo "${{ github.head_ref }}"',
			'      - run: |',
			'          echo ok',
			'          git commit -m "${{ steps.prep.outputs.title }}"',
			'      - run: echo ${{ github.event.pull_request.title }} ${{ inputs.reason }}',
		]);
		assert.deepEqual(find(yaml), ['6:workflow-expression', '9:workflow-expression', '10:workflow-expression', '10:workflow-expression']);
	});

	it('flags a dynamic matrix value but not a static one', () => {
		const dynamic = workflow(['      - run: npm run x -- ${{ matrix.t }}'], '    strategy:\n      matrix:\n        t: ${{ fromJSON(needs.d.outputs.list) }}');
		const fixed = workflow(['      - run: npm run x -- ${{ matrix.t }}'], '    strategy:\n      matrix:\n        t: [a, b]');
		assert.equal(find(dynamic).length, 1);
		assert.deepEqual(find(fixed), []);
	});

	it('flags a github-script script that inlines a step output', () => {
		const yaml = workflow([
			'      - uses: actions/github-script@0000000000000000000000000000000000000000',
			'        with:',
			'          script: |',
			'            core.info("${{ steps.x.outputs.body }}")',
		]);
		assert.deepEqual(find(yaml), ['9:workflow-expression']);
	});

	it('flags an unquoted heredoc delimiter, not a quoted one or one inside a string', () => {
		const yaml = workflow([
			'      - run: |',
			'          cat <<EOF > notes.md',
			'          $BODY',
			'          EOF',
			"          cat <<'EOF' > ok.md",
			'          EOF',
			"          echo 'out<<DELIM' >> \"$GITHUB_OUTPUT\"",
		]);
		assert.deepEqual(find(yaml), ['7:workflow-heredoc']);
	});

	it('accepts env-passed values and contexts without contributor text', () => {
		const yaml = workflow([
			'      - env:',
			'          VERSION: ${{ steps.ver.outputs.version }}',
			'        run: |',
			'          echo "$VERSION" ${{ github.run_id }} ${{ github.sha }} "${{ runner.temp }}"',
			"          if [ '${{ needs.a.result }}' = success ] && [ '${{ github.event_name }}' = push ]; then :; fi",
		]);
		assert.deepEqual(find(yaml), []);
	});
});

describe('repo: workflow scripts take contributor text only through env', () => {
	it('every run: expression is safe or allowlisted with a reason', () => {
		const result = compareWithAllowlist(scan(listWorkflowFiles(), findWorkflowSinks), ALLOWLIST);
		assert.ok(result.unexpected.length === 0 && result.stale.length === 0, report('workflows', result));
	});
});
