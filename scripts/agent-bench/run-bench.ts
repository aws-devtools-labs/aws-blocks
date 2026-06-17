/**
 * Per-cell bench orchestrator. Runs one (template, task) pair inside an
 * AgentCore Harness microVM and writes a single result envelope JSON.
 *
 * Heavy lifting lives in microvm/*.sh; this file is just glue. Bytes between
 * runner and microVM go through S3 under `bench-uploads/<runId>/<cellId>/`.
 *
 * Required env: BENCH_HARNESS_ARN, BENCH_TRANSPORT_BUCKET (AWS_REGION optional).
 *
 * Usage:
 *   tsx run-bench.ts --template default --task realtime-todos --output result.json
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { load as parseYaml } from 'js-yaml';
import { exec, invokeAgent, putToTransport, sessionId, stopSession } from './agentcore.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const MICROVM_DIR = resolve(import.meta.dirname, 'microvm');
const SCHEMA_VERSION = 1;
const SCRIPT_VERSION = 4;

const HARNESS_ARN = required('BENCH_HARNESS_ARN');
const TRANSPORT_BUCKET = required('BENCH_TRANSPORT_BUCKET');

interface TaskConfig {
	id: string;
	name: string;
	tier: string;
	test_file: string;
	time_limit_sec: number;
	token_budget: number;
}

interface Result {
	schema_version: number;
	script_version: number;
	timestamp_utc: string;
	git_sha: string;
	pr_number: string;
	run_id: string;
	template: string;
	task: string;
	model: string;
	status: 'scored' | 'budget_exceeded' | 'error';
	duration_sec: number;
	tokens_in: number;
	tokens_out: number;
	tokens_total: number;
	cache_read_tokens: number;
	budget_exceeded: boolean;
	tests_passed: number;
	tests_failed: number;
	tests_total: number;
	test_pass_rate: number;
	build_succeeded: boolean;
	dev_server_started: boolean;
	scaffolded: boolean;
	judge_score: number | null;
	judge_dimensions: Record<string, number>;
	judge_explanation: string;
	stop_reason: string;
	agent_files: Record<string, string>;
	notes: string[];
}

// Builder system prompt — kept short. Anthropic's guidance ("If your CLAUDE.md
// is too long, Claude ignores half of it") was confirmed empirically: a longer
// prompt with anti-pattern lists, structured workflow, and the embedded test
// spec made the agent more aggressive (5-10x token usage, workspace deletion).
// The minimal prompt below — orient, implement, verify, end — performs better.
const BUILDER_SYSTEM_PROMPT = `You are a senior frontend+backend engineer working in /workspace/bench-app inside a fresh AWS Blocks app.

The project is scaffolded and the dev server is running on the port in /tmp/dev.port. Stay inside /workspace/bench-app/; don't move or delete it (the orchestrator reads from this exact path after you stop). Don't modify node_modules.

Tools available:
  - shell: bash inside this microVM (state persists)
  - file_operations: view/create/edit files

Workflow: read AGENTS.md, package.json, and aws-blocks/index.ts to orient. Read the @aws-blocks package READMEs under node_modules/@aws-blocks/* to learn which blocks fit. Edit files under /workspace/bench-app/ to implement the task. Verify against the dev server (curl http://localhost:$(cat /tmp/dev.port)). Before stopping, run \`npm run build\` and fix until it exits 0. Don't \`npm install\` extra packages — node_modules has what you need. End with end_turn.`;

const JUDGE_SYSTEM_PROMPT = `You are an impartial grader scoring an AI agent's implementation of a coding task.

You have file_operations tool access against the agent's workspace at /workspace/bench-app/. The workspace is filesystem read-only — any write attempts will fail.
Useful files to inspect when grading: aws-blocks/index.ts, src/index.ts (or src/main.tsx), index.html, package.json.

Grade against the rubric below. Cite specific files when you do — the audit trail is the point.
Return ONLY a JSON object matching the exact shape requested. No prose, no preamble, no code fences.`;

const JUDGE_RUBRIC = `Dimensions (each 0-10):

1. functional_completeness  (weight 3.0) — Does the implementation actually meet the prompt's requirements?
2. selector_contract        (weight 1.5) — Are the data-testid hooks present and correct?
3. realtime_quality         (weight 1.5) — Does cross-tab sync work without refresh?
4. persistence              (weight 1.0) — Do todos survive a reload?
5. code_quality             (weight 0.5) — Is the implementation clean and idiomatic for this stack?

HARD CAPS (apply BEFORE the weighted average):
- If scaffolded == false  →  every dimension CANNOT exceed 1.
- If tests_total > 0 and tests_passed == 0  →  functional_completeness CANNOT exceed 4.
- If tests_total > 0 and tests_passed/tests_total < 0.5  →  functional_completeness CANNOT exceed 6.
- If build_succeeded == false  →  functional_completeness CANNOT exceed 3.
- If dev_server_started == false  →  functional_completeness AND selector_contract CANNOT exceed 2.

Compute overall = sum(score_i * weight_i) / sum(weights). Round to 2 decimals.

Return JSON exactly like:
{
  "scores": {
    "functional_completeness": <0-10>,
    "selector_contract": <0-10>,
    "realtime_quality": <0-10>,
    "persistence": <0-10>,
    "code_quality": <0-10>
  },
  "overall": <0-10>,
  "explanation": "<2-4 sentences citing specific evidence>"
}`;

function required(name: string): string {
	const v = process.env[name];
	if (!v) {
		process.stderr.write(`[bench] missing required env var ${name}\n`);
		process.exit(1);
	}
	return v;
}

function log(msg: string) {
	process.stderr.write(`[bench] ${msg}\n`);
}

function loadTask(taskId: string) {
	const taskDir = resolve(REPO_ROOT, 'tasks', taskId);
	const cfg = parseYaml(readFileSync(resolve(taskDir, 'config.yaml'), 'utf-8')) as TaskConfig;
	const prompt = readFileSync(resolve(taskDir, 'PROMPT.md'), 'utf-8');
	const specPath = resolve(taskDir, cfg.test_file);
	return { cfg, prompt, specPath };
}

function packDistRegistry(): string {
	const path = '/tmp/dist-registry.tgz';
	execSync(`tar -czf ${path} -C ${resolve(REPO_ROOT, 'dist-registry')} .`);
	return path;
}

function parsePlaywrightJson(stdout: string) {
	const start = stdout.indexOf('{');
	const end = stdout.lastIndexOf('}');
	if (start === -1 || end === -1) return { passed: 0, failed: 0, total: 0 };
	let data: { stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number } };
	try {
		data = JSON.parse(stdout.slice(start, end + 1));
	} catch {
		return { passed: 0, failed: 0, total: 0 };
	}
	const s = data.stats ?? {};
	const expected = s.expected ?? 0;
	const unexpected = s.unexpected ?? 0;
	const skipped = s.skipped ?? 0;
	const flaky = s.flaky ?? 0;
	return { passed: expected + flaky, failed: unexpected, total: expected + unexpected + skipped + flaky };
}

function extractJson(text: string): string {
	const cleaned = text.replace(/^```(?:json)?\s*|```\s*$/g, '').trim();
	const start = cleaned.indexOf('{');
	const end = cleaned.lastIndexOf('}');
	return start === -1 || end === -1 ? cleaned : cleaned.slice(start, end + 1);
}

function tail(s: string, n: number): string {
	return s.length <= n ? s : `...[truncated]...\n${s.slice(-n)}`;
}

async function main() {
	const { values: args } = parseArgs({
		options: { template: { type: 'string' }, task: { type: 'string' }, output: { type: 'string' } },
		strict: true,
	});
	if (!args.template || !args.task || !args.output) {
		process.stderr.write('usage: --template <name> --task <id> --output <path>\n');
		process.exit(2);
	}

	const { cfg, prompt: taskPrompt, specPath } = loadTask(args.task);
	log(`task=${cfg.id} template=${args.template}`);

	const started = Date.now();
	const benchSession = sessionId(`bench-${args.template}-${args.task}`);
	const cellId = `${args.template}-${args.task}`;
	const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
	const transportPrefix = `s3://${TRANSPORT_BUCKET}/bench-uploads/${runId}/${cellId}`;

	const result: Result = {
		schema_version: SCHEMA_VERSION,
		script_version: SCRIPT_VERSION,
		timestamp_utc: new Date().toISOString(),
		git_sha: process.env.GITHUB_SHA ?? '',
		pr_number: process.env.PR_NUMBER ?? 'local',
		run_id: runId,
		template: args.template,
		task: cfg.id,
		model: 'us.anthropic.claude-sonnet-4-6',
		status: 'error',
		duration_sec: 0,
		tokens_in: 0,
		tokens_out: 0,
		tokens_total: 0,
		cache_read_tokens: 0,
		budget_exceeded: false,
		tests_passed: 0,
		tests_failed: 0,
		tests_total: 0,
		test_pass_rate: 0,
		build_succeeded: false,
		dev_server_started: false,
		scaffolded: false,
		judge_score: null,
		judge_dimensions: {},
		judge_explanation: '',
		stop_reason: '',
		agent_files: {},
		notes: [],
	};

	const upload = (name: string, body: Buffer | string, contentType?: string) =>
		putToTransport({ bucket: TRANSPORT_BUCKET, runId, cellId, name, body, contentType });

	try {
		// 1. Push everything the microVM needs to S3 (registry tarball, registry
		// server script, the three bootstrap shell scripts, the playwright spec).
		log('uploading microVM scripts and dist-registry');
		const tarballPath = packDistRegistry();
		await upload('dist-registry.tgz', readFileSync(tarballPath), 'application/gzip');

		const serveScript = readFileSync(resolve(REPO_ROOT, 'scripts/publish/serve-local-registry.ts'), 'utf-8')
			.replace('const ROOT = resolve(import.meta.dirname, "../..");', 'const ROOT = "/workspace";')
			.replace('const REGISTRY_DIR = join(ROOT, "dist-registry");', 'const REGISTRY_DIR = "/workspace/dist-registry";');
		await upload('serve-local-registry.ts', serveScript, 'text/x-typescript');

		for (const sh of ['bootstrap.sh', 'setup-app.sh', 'capture-files.sh']) {
			await upload(sh, readFileSync(resolve(MICROVM_DIR, sh)));
		}

		// 2. Bootstrap microVM (Node 22, dist-registry, registry server).
		log('bootstrapping microVM');
		const env = `export TRANSPORT_PREFIX='${transportPrefix}'`;
		const fetchScripts = `aws s3 cp '${transportPrefix}/bootstrap.sh' /tmp/bootstrap.sh && aws s3 cp '${transportPrefix}/setup-app.sh' /tmp/setup-app.sh && aws s3 cp '${transportPrefix}/capture-files.sh' /tmp/capture-files.sh && chmod +x /tmp/*.sh`;
		const bootstrap = await exec(HARNESS_ARN, benchSession, `${env}; ${fetchScripts} && bash /tmp/bootstrap.sh`, 420);
		if (bootstrap.exitCode !== 0) {
			result.notes.push(`bootstrap failed (exit ${bootstrap.exitCode}): ${tail(bootstrap.stdout + bootstrap.stderr, 1500)}`);
			throw new Error('bootstrap failed');
		}

		// 3. Scaffold app and start dev server.
		log('scaffolding bench-app');
		const setup = await exec(HARNESS_ARN, benchSession, `bash /tmp/setup-app.sh '${args.template}'`, 600);
		result.scaffolded = setup.exitCode === 0;
		const portMatch = setup.stdout.match(/dev-server-up:(\d+)/);
		const devPort = portMatch ? Number.parseInt(portMatch[1], 10) : 3000;
		result.dev_server_started = portMatch != null;
		if (!result.scaffolded || !result.dev_server_started) {
			result.notes.push(`setup failed (exit ${setup.exitCode}): ${tail(setup.stdout + setup.stderr, 2000)}`);
			throw new Error('setup failed');
		}

		// 4. Builder agent. Pass the task prompt as-is — embedding the
		// Playwright spec was tested and tripled token usage without improving
		// scores (the agent over-iterated trying to match selectors that the
		// AGENTS.md guide already documents). The grader still gets the spec.
		log('invoking builder agent');
		const builder = await invokeAgent(HARNESS_ARN, benchSession, {
			systemPrompt: BUILDER_SYSTEM_PROMPT,
			userText: taskPrompt,
			// Explicit stopping conditions per Anthropic's "Building effective
			// agents" guidance. 100 iterations suits our task shape (typical
			// runs use 30-60); 20min covers slow npm builds. Higher caps caused
			// pathological loops that nuked the workspace.
			maxIterations: 100,
			timeoutSeconds: 1200,
		});
		result.tokens_in = builder.tokensIn;
		result.tokens_out = builder.tokensOut;
		result.tokens_total = builder.tokensIn + builder.tokensOut;
		result.cache_read_tokens = builder.cacheReadTokens;
		result.stop_reason = builder.stopReason;
		result.budget_exceeded = result.tokens_total > cfg.token_budget;
		if (result.budget_exceeded) {
			result.notes.push(`token budget exceeded: ${result.tokens_total} > ${cfg.token_budget}`);
		}
		if (builder.stopReason && builder.stopReason !== 'end_turn') {
			result.notes.push(`builder stop_reason=${builder.stopReason}`);
		}

		// 5. Build sanity check (skipped if the agent trashed its workspace).
		const integrity = await exec(
			HARNESS_ARN,
			benchSession,
			`[ -d /workspace/bench-app ] && [ -f /workspace/bench-app/package.json ] && echo workspace-ok || { echo workspace-missing; ls /workspace; exit 1; }`,
			60,
		);
		if (!integrity.stdout.includes('workspace-ok')) {
			result.notes.push(`workspace missing after builder turn: ${tail(integrity.stdout, 500)}`);
			result.status = 'error';
			return;
		}
		log('npm run build');
		const build = await exec(HARNESS_ARN, benchSession, `cd /workspace/bench-app && npm run build`, 600);
		result.build_succeeded = build.exitCode === 0;
		if (!result.build_succeeded) {
			result.notes.push(`build failed:\n${tail(build.stdout + build.stderr, 2000)}`);
		}

		// 6. Playwright.
		log('uploading Playwright spec + config and running tests');
		await upload('task.spec.ts', readFileSync(specPath), 'text/x-typescript');
		await upload(
			'playwright.config.ts',
			`import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './bench-tests',
  timeout: 60_000,
  reporter: [['json']],
  use: { baseURL: 'http://localhost:${devPort}' },
});
`,
			'text/x-typescript',
		);
		const test = await exec(
			HARNESS_ARN,
			benchSession,
			`set -e
cd /workspace/bench-app
mkdir -p bench-tests
aws s3 cp '${transportPrefix}/task.spec.ts' bench-tests/task.spec.ts
aws s3 cp '${transportPrefix}/playwright.config.ts' playwright.config.ts
npm install --no-save --silent @playwright/test >/dev/null
npx playwright install chromium >/tmp/pw-install.log 2>&1 || true
npx playwright test --reporter=json 2>&1 || true`,
			900,
		);
		const tests = parsePlaywrightJson(test.stdout);
		result.tests_passed = tests.passed;
		result.tests_failed = tests.failed;
		result.tests_total = tests.total;
		result.test_pass_rate = tests.total > 0 ? tests.passed / tests.total : 0;

		// 7. Judge — same session, workspace chmod'd read-only, no shell.
		// Tight caps keep it focused on inspect → JSON; 50 iterations is plenty
		// for read-only file inspection, 4K tokens forces concise output.
		log('locking workspace read-only and invoking judge');
		await exec(HARNESS_ARN, benchSession, `chmod -R a-w /workspace/bench-app`);
		const judge = await invokeAgent(HARNESS_ARN, benchSession, {
			systemPrompt: JUDGE_SYSTEM_PROMPT,
			userText:
				`<rubric>\n${JUDGE_RUBRIC}\n</rubric>\n\n` +
				`<prompt_given_to_agent>\n${taskPrompt}\n</prompt_given_to_agent>\n\n` +
				`<evidence>\nscaffolded: ${result.scaffolded}\nbuild_succeeded: ${result.build_succeeded}\ndev_server_started: ${result.dev_server_started}\ntests_total: ${result.tests_total}\ntests_passed: ${result.tests_passed}\ntests_failed: ${result.tests_failed}\n</evidence>\n\n` +
				`Inspect /workspace/bench-app/ then return the JSON object.`,
			allowedTools: ['file_operations'],
			maxIterations: 50,
			maxTokens: 4096,
			timeoutSeconds: 300,
		});
		result.tokens_in += judge.tokensIn;
		result.tokens_out += judge.tokensOut;
		result.tokens_total = result.tokens_in + result.tokens_out;
		try {
			const parsed = JSON.parse(extractJson(judge.text)) as {
				scores?: Record<string, number>;
				overall?: number;
				explanation?: string;
			};
			result.judge_score = parsed.overall ?? null;
			result.judge_dimensions = parsed.scores ?? {};
			result.judge_explanation = parsed.explanation ?? '';
		} catch (err) {
			result.notes.push(`judge JSON parse failed: ${(err as Error).message}; raw=${judge.text.slice(0, 500)}`);
		}

		// 8. Capture agent files via S3 round-trip.
		log('capturing agent files');
		const capture = await exec(HARNESS_ARN, benchSession, `${env} && bash /tmp/capture-files.sh`, 120);
		if (capture.exitCode === 0) {
			const tmpTgz = `/tmp/agent-files-${cellId}.tgz`;
			const tmpDir = `/tmp/agent-files-${cellId}`;
			execSync(`aws s3 cp ${transportPrefix}/agent-files.tgz ${tmpTgz} --only-show-errors`);
			execSync(`rm -rf ${tmpDir} && mkdir -p ${tmpDir} && tar -xzf ${tmpTgz} -C ${tmpDir}`);
			const MAX_FILES = 200;
			const MAX_BYTES = 64 * 1024;
			let captured = 0;
			for (const path of walk(tmpDir)) {
				if (captured >= MAX_FILES) break;
				const rel = path.slice(tmpDir.length + 1);
				try {
					const size = statSync(path).size;
					result.agent_files[rel] =
						size > MAX_BYTES ? `[truncated: ${size} bytes > ${MAX_BYTES}]` : readFileSync(path, 'utf-8');
					captured++;
				} catch {
					// non-utf8 / unreadable
				}
			}
			if (captured >= MAX_FILES) result.notes.push(`agent_files capped at ${MAX_FILES} entries`);
		} else {
			result.notes.push(`agent_files capture failed (exit ${capture.exitCode}): ${tail(capture.stdout + capture.stderr, 500)}`);
		}

		result.status = result.budget_exceeded ? 'budget_exceeded' : 'scored';
	} catch (err) {
		result.notes.push(`orchestrator error: ${(err as Error).message}`);
	} finally {
		await stopSession(HARNESS_ARN, benchSession);
		result.duration_sec = Math.round((Date.now() - started) / 100) / 10;
		mkdirSync(dirname(args.output), { recursive: true });
		writeFileSync(args.output, JSON.stringify(result, null, 2));
		writeFileSync(args.output.replace(/\.json$/, '.jsonl'), `${JSON.stringify(result)}\n`);
		log(`wrote ${args.output}`);
	}
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = resolve(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}

main().catch((err) => {
	process.stderr.write(`[bench] fatal: ${err.stack ?? err}\n`);
	process.exit(1);
});
