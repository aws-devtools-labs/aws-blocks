// Step 0: write a baseline result.json before any other step runs.
// Each subsequent step overwrites or augments fields. If any step fails,
// the partial result still uploads as an artifact and shows up in the
// summary table with the right "failed at step N" indicator instead of
// being silently missing.
import { writeFileSync } from 'node:fs';

const RESULT_PATH = process.env.RESULT_PATH ?? '/tmp/result.json';

writeFileSync(
	RESULT_PATH,
	JSON.stringify(
		{
			template: process.env.TEMPLATE ?? '',
			task: process.env.TASK ?? '',
			pr_number: process.env.PR_NUMBER ?? '',
			run_id: process.env.GITHUB_RUN_ID ?? '',
			git_sha: process.env.GITHUB_SHA ?? '',
			status: 'init',
			scaffolded: false,
			build_succeeded: false,
			// Tri-state the build cap keys off (na|ok|failed); seed the same
			// pessimistic default as build_succeeded so an early abort (before
			// 3-build-test / 4-judge write the real value) still renders a
			// consistent 'failed' in the summary. Composite scoring never reads
			// this field, so seeding it moves no score.
			build_status: 'failed',
			dev_server_started: false,
			playwright_installed: false,
			tests_passed: 0,
			tests_failed: 0,
			tests_total: 0,
			tokens_in: 0,
			tokens_out: 0,
			stop_reason: '',
			judge_score: null,
			judge_dimensions: {},
			judge_explanation: '',
			notes: [],
		},
		null,
		2,
	),
);
process.stderr.write(`[init-result] wrote baseline ${RESULT_PATH}\n`);
