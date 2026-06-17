/**
 * Per-cell bench orchestrator.
 *
 * Reads one (template, task) from CLI flags, runs the bench inside an AgentCore
 * Harness microVM, and writes a single result envelope JSON.
 *
 * Bytes between the runner and microVM go through S3 (bench-uploads/* prefix).
 * Bytes between the agent and the model are the harness's responsibility.
 * Shell commands and agent turns go through agentcore.ts.
 *
 * Required env:
 *   BENCH_HARNESS_ARN        the harness ARN
 *   BENCH_TRANSPORT_BUCKET   bucket the runner uploads tarballs/specs to
 *   AWS_REGION               defaults to us-east-1
 *
 * Usage:
 *   tsx scripts/agent-bench/run-bench.ts \
 *     --template default \
 *     --task realtime-todos \
 *     --output bench-results/result-default-realtime-todos.json
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { load as parseYaml } from 'js-yaml';
import {
	exec,
	invokeAgent,
	putToTransport,
	sessionId,
	stopSession,
	type ExecResult,
} from './agentcore.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SCHEMA_VERSION = 1;
const SCRIPT_VERSION = 3; // bump when the orchestrator changes shape

const HARNESS_ARN = required('BENCH_HARNESS_ARN');
const TRANSPORT_BUCKET = required('BENCH_TRANSPORT_BUCKET');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const BUILDER_SYSTEM_PROMPT = `You are a senior frontend+backend engineer working in /workspace/bench-app inside a fresh AWS Blocks app.

The dist-registry has already been pushed into /workspace/dist-registry; the project is scaffolded and dev server is running on http://localhost:3000.

Tools available to you:
  - shell: bash inside this microVM. State persists across calls.
  - file_operations: read/write/edit files.

Workflow:
  1. Read AGENTS.md, package.json, and aws-blocks/index.ts to orient yourself.
  2. Read the relevant @aws-blocks package READMEs under node_modules/@aws-blocks/* to learn which blocks fit the task.
  3. Edit files under /workspace/bench-app/ to implement the task. Don't modify node_modules.
  4. Verify against the running dev server (curl, etc.).
  5. Before stopping, run \`npm run build\` from /workspace/bench-app. The dev server uses tsx and is permissive about types; the real build is strict. Fix any errors until build exits 0.

Don't \`npm install\` extra packages — everything you need is already in node_modules. Be concise between tool calls; the work is in the tools, not the prose.`;

const JUDGE_SYSTEM_PROMPT = `You are an impartial grader scoring an AI agent's implementation of a coding task.

You have file_operations tool access against the agent's workspace at /workspace/bench-app/.
The workspace is filesystem read-only — any write attempts will fail.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function loadTask(taskId: string): { cfg: TaskConfig; prompt: string; specPath: string } {
	const taskDir = resolve(REPO_ROOT, 'tasks', taskId);
	const cfg = parseYaml(readFileSync(resolve(taskDir, 'config.yaml'), 'utf-8')) as TaskConfig;
	const prompt = readFileSync(resolve(taskDir, 'PROMPT.md'), 'utf-8');
	const specPath = resolve(taskDir, cfg.test_file);
	return { cfg, prompt, specPath };
}

function packDistRegistry(): { tarballPath: string; sizeBytes: number } {
	const tarballPath = '/tmp/dist-registry.tgz';
	// Packument tarball URLs stay as `http://localhost:4873/registry/...`. We
	// run the existing serve-local-registry.ts script inside the microVM to
	// serve them on that same address. npm refuses `file://` tarball URLs.
	execSync(`tar -czf ${tarballPath} -C ${resolve(REPO_ROOT, 'dist-registry')} .`);
	return { tarballPath, sizeBytes: statSync(tarballPath).size };
}

function walk(dir: string, basename: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = resolve(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full, basename));
		else if (entry.name === basename) out.push(full);
	}
	return out;
}

function parsePlaywrightJson(stdout: string): { passed: number; failed: number; total: number } {
	const start = stdout.indexOf('{');
	const end = stdout.lastIndexOf('}');
	if (start === -1 || end === -1) return { passed: 0, failed: 0, total: 0 };
	let data: { stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number } };
	try {
		data = JSON.parse(stdout.slice(start, end + 1));
	} catch {
		return { passed: 0, failed: 0, total: 0 };
	}
	const stats = data.stats ?? {};
	const expected = stats.expected ?? 0;
	const unexpected = stats.unexpected ?? 0;
	const skipped = stats.skipped ?? 0;
	const flaky = stats.flaky ?? 0;
	return {
		passed: expected + flaky,
		failed: unexpected,
		total: expected + unexpected + skipped + flaky,
	};
}

function extractJson(text: string): string {
	const cleaned = text.replace(/^```(?:json)?\s*|```\s*$/g, '').trim();
	const start = cleaned.indexOf('{');
	const end = cleaned.lastIndexOf('}');
	if (start === -1 || end === -1) return cleaned;
	return cleaned.slice(start, end + 1);
}

function assertOk(r: ExecResult, what: string, result: Result): void {
	if (r.exitCode !== 0) {
		result.notes.push(`${what} failed (exit ${r.exitCode}):\n${tail(r.stdout + r.stderr, 1500)}`);
		throw new Error(what);
	}
}

function tail(s: string, n: number): string {
	return s.length <= n ? s : `...[truncated]...\n${s.slice(-n)}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const { values: args } = parseArgs({
		options: {
			template: { type: 'string' },
			task: { type: 'string' },
			output: { type: 'string' },
		},
		strict: true,
	});
	if (!args.template || !args.task || !args.output) {
		process.stderr.write('usage: --template <name> --task <id> --output <path>\n');
		process.exit(2);
	}

	const { cfg, prompt: taskPrompt, specPath } = loadTask(args.task);
	log(`task=${cfg.id} template=${args.template}`);

	const started = Date.now();
	// Builder and judge share one session so the judge sees the workspace the
	// builder wrote. Read-only enforcement comes from `chmod -R a-w` against
	// /workspace/bench-app/ before the judge turn, plus allowedTools restricted
	// to file_operations (no shell). The harness toolset is monolithic — there
	// is no separate read-only file tool — so OS-level permissions are the only
	// real boundary.
	const benchSession = sessionId(`bench-${args.template}-${args.task}`);
	const cellId = `${args.template}-${args.task}`;

	const result: Result = {
		schema_version: SCHEMA_VERSION,
		script_version: SCRIPT_VERSION,
		timestamp_utc: new Date().toISOString(),
		git_sha: process.env.GITHUB_SHA ?? '',
		pr_number: process.env.PR_NUMBER ?? 'local',
		run_id: process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`,
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

	const transport = (name: string, body: Buffer | string, contentType?: string) =>
		putToTransport({
			bucket: TRANSPORT_BUCKET,
			runId: result.run_id,
			cellId,
			name,
			body,
			contentType,
		});

	try {
		// 1a. Install the microVM toolchain. AL2023 ships awscli + curl + bash;
		// we need tar/gzip + Node 22 (the dev server uses process.loadEnvFile, a
		// Node 20.6+ API; AL2023's default nodejs package is 18). NodeSource for
		// arm64 / RPM gives us a current node.
		log('installing toolchain in microVM (Node 22)');
		const toolchain = await exec(
			HARNESS_ARN,
			benchSession,
			`set -e
dnf install -y tar gzip 2>&1 | tail -5
# NodeSource is the canonical path to a current node on AL2023.
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/tmp/nodesource.log 2>&1
dnf install -y nodejs 2>&1 | tail -5
node --version
npm --version`,
			420,
		);
		assertOk(toolchain, 'toolchain install', result);

		// 1b. Pack the local dist-registry, upload to S3, pull down in the microVM.
		log('packing dist-registry');
		const { tarballPath, sizeBytes } = packDistRegistry();
		log(`dist-registry: ${(sizeBytes / 1024 / 1024).toFixed(1)}MB`);
		const tarballUri = await transport('dist-registry.tgz', readFileSync(tarballPath), 'application/gzip');

		// 1c. Upload the registry-server script too. We run it inside the microVM
		// because npm's packuments reference http://localhost:4873/... and npm
		// rejects file:// tarball URLs.
		const serveScript = readFileSync(
			resolve(REPO_ROOT, 'scripts/publish/serve-local-registry.ts'),
			'utf-8',
		);
		// Adjust the registry-root path to /workspace/dist-registry inside the microVM.
		const serveAdapted = serveScript
			.replace(
				'const ROOT = resolve(import.meta.dirname, "../..");',
				'const ROOT = "/workspace";',
			)
			.replace(
				'const REGISTRY_DIR = join(ROOT, "dist-registry");',
				'const REGISTRY_DIR = "/workspace/dist-registry";',
			);
		const serveUri = await transport(
			'serve-local-registry.ts',
			serveAdapted,
			'text/x-typescript',
		);
		log(`uploaded ${tarballUri}`);

		const extract = await exec(
			HARNESS_ARN,
			benchSession,
			`set -e
mkdir -p /workspace/dist-registry
aws s3 cp '${tarballUri}' /tmp/dist-registry.tgz
aws s3 cp '${serveUri}' /tmp/serve-local-registry.ts
tar -xzf /tmp/dist-registry.tgz -C /workspace/dist-registry
ls /workspace/dist-registry/registry/@aws-blocks | head -5`,
		);
		assertOk(extract, 'dist-registry extract', result);

		// 1d. Start the local registry server inside the microVM and wait for it.
		log('starting in-microVM registry server');
		const startRegistry = await exec(
			HARNESS_ARN,
			benchSession,
			`set -e
# Install tsx globally so we can run the .ts directly without project setup.
npm install -g tsx 2>&1 | tail -3
nohup tsx /tmp/serve-local-registry.ts > /tmp/registry.log 2>&1 &
echo $! > /tmp/registry.pid
for i in $(seq 1 30); do
  if curl -sf http://localhost:4873/registry/@aws-blocks/blocks > /dev/null; then
    echo "registry-up"; exit 0
  fi
  sleep 1
done
echo '>>> registry server failed to start; tail of log:'
tail -50 /tmp/registry.log
exit 1`,
			300,
		);
		assertOk(startRegistry, 'in-microVM registry start', result);

		// 2. Scaffold the app, start dev server.
		log('scaffolding bench-app');
		const setup = await exec(
			HARNESS_ARN,
			benchSession,
			`set -eo pipefail
cd /workspace
cat > .npmrc <<'EOF'
@aws-blocks:registry=http://localhost:4873/registry/
EOF
echo '>>> installing @aws-blocks/create-blocks-app from local registry'
npm install --no-save @aws-blocks/create-blocks-app 2>&1 | tail -10
echo '>>> scaffolding bench-app'
./node_modules/.bin/create-blocks-app bench-app${args.template === 'default' ? '' : ` --template ${args.template}`} 2>&1 | tail -20
echo '>>> starting dev server'
cd bench-app
nohup npm run dev > /tmp/dev.log 2>&1 &
echo $! > /tmp/dev.pid
for i in $(seq 1 60); do
  if curl -sf http://localhost:3000 > /dev/null; then
    echo "dev-server-up"; exit 0
  fi
  sleep 1
done
echo '>>> dev server timed out; tail of /tmp/dev.log:'
tail -50 /tmp/dev.log
exit 1
`,
			600,
		);
		result.scaffolded = setup.exitCode === 0;
		result.dev_server_started = setup.stdout.includes('dev-server-up');
		if (!result.scaffolded || !result.dev_server_started) {
			result.notes.push(`setup failed (exit ${setup.exitCode}): ${tail(setup.stdout + setup.stderr, 2000)}`);
			throw new Error('setup failed');
		}

		// 3. Builder agent.
		log('invoking builder agent');
		const builder = await invokeAgent(HARNESS_ARN, benchSession, {
			systemPrompt: BUILDER_SYSTEM_PROMPT,
			userText: taskPrompt,
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

		// 4. Build sanity check.
		log('npm run build');
		const build = await exec(HARNESS_ARN, benchSession, `cd /workspace/bench-app && npm run build`, 600);
		result.build_succeeded = build.exitCode === 0;
		if (!result.build_succeeded) {
			result.notes.push(`build failed:\n${tail(build.stdout + build.stderr, 2000)}`);
		}

		// 5. Playwright. Spec + config land in the microVM through S3 too.
		log('uploading Playwright spec + config');
		const specUri = await transport('task.spec.ts', readFileSync(specPath), 'text/x-typescript');
		const configUri = await transport(
			'playwright.config.ts',
			`import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './bench-tests',
  timeout: 60_000,
  reporter: [['json']],
  use: { baseURL: 'http://localhost:3000' },
});
`,
			'text/x-typescript',
		);
		log('running Playwright');
		const test = await exec(
			HARNESS_ARN,
			benchSession,
			`set -e
cd /workspace/bench-app
mkdir -p bench-tests
aws s3 cp '${specUri}' bench-tests/task.spec.ts
aws s3 cp '${configUri}' playwright.config.ts
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

		// 6. Judge — same session as the builder so the workspace files are
		// already there, but with the workspace chmod'd read-only and shell
		// access removed. The harness's file_operations tool is monolithic
		// (view+create+edit), so OS permissions are the only real read-only
		// boundary. Both file_operations writes and shell are out of reach
		// for the judge: the former by chmod, the latter by allowedTools.
		log('locking workspace read-only');
		await exec(
			HARNESS_ARN,
			benchSession,
			`chmod -R a-w /workspace/bench-app && find /workspace/bench-app -maxdepth 1 -type d -ls | head -5`,
		);
		log('invoking judge agent');
		const judge = await invokeAgent(HARNESS_ARN, benchSession, {
			systemPrompt: JUDGE_SYSTEM_PROMPT,
			userText:
				`<rubric>\n${JUDGE_RUBRIC}\n</rubric>\n\n` +
				`<prompt_given_to_agent>\n${taskPrompt}\n</prompt_given_to_agent>\n\n` +
				`<evidence>\nscaffolded: ${result.scaffolded}\nbuild_succeeded: ${result.build_succeeded}\ndev_server_started: ${result.dev_server_started}\ntests_total: ${result.tests_total}\ntests_passed: ${result.tests_passed}\ntests_failed: ${result.tests_failed}\n</evidence>\n\n` +
				`Inspect /workspace/bench-app/ then return the JSON object.`,
			allowedTools: ['file_operations'],
		});
		result.tokens_in += judge.tokensIn;
		result.tokens_out += judge.tokensOut;
		result.tokens_total = result.tokens_in + result.tokens_out;
		try {
			const parsed: { scores?: Record<string, number>; overall?: number; explanation?: string } = JSON.parse(
				extractJson(judge.text),
			);
			result.judge_score = parsed.overall ?? null;
			result.judge_dimensions = parsed.scores ?? {};
			result.judge_explanation = parsed.explanation ?? '';
		} catch (err) {
			result.notes.push(
				`judge JSON parse failed: ${(err as Error).message}; raw=${judge.text.slice(0, 500)}`,
			);
		}

		// 7. Capture the files the agent wrote — for inspection in the envelope.
		// Tar them into one upload to keep this O(1) rather than O(N) round trips.
		const captureUri = `s3://${TRANSPORT_BUCKET}/bench-uploads/${result.run_id}/${cellId}/agent-files.tgz`;
		const capture = await exec(
			HARNESS_ARN,
			benchSession,
			`set -e
cd /workspace/bench-app
tar -czf /tmp/agent-files.tgz \
  --ignore-failed-read \
  aws-blocks/index.ts aws-blocks/index.cdk.ts aws-blocks/index.handler.ts \
  src/index.ts src/main.tsx src/App.tsx index.html package.json 2>/dev/null || true
aws s3 cp /tmp/agent-files.tgz '${captureUri}'`,
		);
		if (capture.exitCode === 0) {
			// Pull the tarball, extract, read each file into the envelope.
			execSync(`aws s3 cp ${captureUri} /tmp/agent-files-${cellId}.tgz --only-show-errors`);
			const tmpDir = `/tmp/agent-files-${cellId}`;
			execSync(`rm -rf ${tmpDir} && mkdir -p ${tmpDir} && tar -xzf /tmp/agent-files-${cellId}.tgz -C ${tmpDir}`);
			for (const path of walkAll(tmpDir)) {
				const rel = path.slice(tmpDir.length + 1);
				try {
					result.agent_files[rel] = readFileSync(path, 'utf-8');
				} catch {
					// non-utf8 file — skip silently
				}
			}
		}

		result.status = result.budget_exceeded ? 'budget_exceeded' : 'scored';
	} catch (err) {
		result.notes.push(`orchestrator error: ${(err as Error).message}`);
	} finally {
		// Release the microVM promptly so the per-account session quota isn't
		// tied up. Best-effort; the harness's idle timeout is the backstop.
		await stopSession(HARNESS_ARN, benchSession);
		result.duration_sec = Math.round((Date.now() - started) / 100) / 10;
		mkdirSync(dirname(args.output), { recursive: true });
		writeFileSync(args.output, JSON.stringify(result, null, 2));
		writeFileSync(args.output.replace(/\.json$/, '.jsonl'), `${JSON.stringify(result)}\n`);
		log(`wrote ${args.output}`);
	}
}

function walkAll(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = resolve(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkAll(full));
		else out.push(full);
	}
	return out;
}

main().catch((err) => {
	process.stderr.write(`[bench] fatal: ${err.stack ?? err}\n`);
	process.exit(1);
});
