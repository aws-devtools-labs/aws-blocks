/**
 * Dependency-remediation agent entrypoint.
 *
 * Invoked by .github/workflows/dependency-update.yml ONLY when the weekly minor-only dependency bump
 * broke `npm run build` and/or `npm run test:e2e:local`. A Strands agent — given the framework's vended
 * `bash` + `fileEditor` routed through a WorkspaceSandbox rooted at the repo — is asked to patch OUR
 * source to absorb the breaking "minor" change (or resolve a dependency conflict) until build + e2e go
 * green again. It never reverts the version bumps (see prompts.ts). The workflow re-runs build + e2e
 * after this exits and is the authoritative gate — this script just does the fixing.
 *
 * Inputs (env):
 *   WORKSPACE               repo root (agent cwd + sandbox root). Required.
 *   BUILD_OUTCOME           'success' | 'failure' | 'skipped' — the first-pass build step outcome.
 *   E2E_OUTCOME             'success' | 'failure' | 'skipped' — the first-pass e2e step outcome.
 *   DEP_REMEDIATION_MODEL   Bedrock model id (default us.anthropic.claude-opus-4-8).
 *   AWS_REGION              default us-east-1.
 *   DEP_CMD_LOG             optional path; run-shell appends one JSON line per shell command.
 *
 * Exit codes: 0 = agent ran to a normal stop (the workflow's re-verify decides pass/fail);
 *             1 = the agent could not be invoked at all (all Bedrock attempts failed / config error).
 */
import { writeFileSync } from 'node:fs';
import { Agent, type AgentResult, BedrockModel } from '@strands-agents/sdk';
import { makeBash } from '@strands-agents/sdk/vended-tools/bash';
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor';
import { remediationSystem } from './prompts.ts';
import {
	INVOKE_MAX_ATTEMPTS,
	describeModelError,
	isRetryableModelError,
	nextBackoffMs,
	sleep,
} from './steps/bedrock-retry.ts';
import { WorkspaceSandbox, describeError, required } from './steps/run-shell.ts';
import { summarizeFailure } from './steps/summarize.mjs';

const LOG = '[dep-remediation]';
const WORKSPACE = required('WORKSPACE', LOG);
const MODEL_ID = process.env.DEP_REMEDIATION_MODEL ?? 'us.anthropic.claude-opus-4-8';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
// Opus rejects the `temperature` parameter; only pin temperature=0 for models that accept it.
const MODEL_ACCEPTS_TEMPERATURE = !/opus/i.test(MODEL_ID);
// Runaway-loop backstop (one turn = one model call + its tool calls). The real bound is the step's
// 40-min wall-clock cap in the workflow; this leaves ample headroom for a multi-package fix.
const MAX_TURNS = 150;
// Floor for the vended bash timeout (s): its 120s default kills npm install/build. 15 min is ample
// for a full monorepo build or an e2e run against the local dev server.
const BASH_MIN_TIMEOUT_SEC = 900;

const failure = summarizeFailure(process.env.BUILD_OUTCOME, process.env.E2E_OUTCOME);
process.stderr.write(`${LOG} model=${MODEL_ID} region=${REGION} workspace=${WORKSPACE} — ${failure}\n`);

// A minimal agent: the framework's vended `bash` + `fileEditor`, both routed through a WORKSPACE-rooted
// Sandbox (containment is structural). Fresh agent per invoke attempt — a mid-stream failure can leave a
// half-built conversation, so each retry starts clean.
function makeRemediationAgent(): Agent {
	return new Agent({
		model: new BedrockModel({
			modelId: MODEL_ID,
			region: REGION,
			...(MODEL_ACCEPTS_TEMPERATURE ? { temperature: 0 } : {}),
			// AWS-SDK-layer adaptive retry — the lower half of the two-layer throttle defense (the
			// app-level loop around invoke() is the upper half); often absorbs a TPM throttle inside invoke.
			clientConfig: { maxAttempts: 8, retryMode: 'adaptive' },
		}),
		systemPrompt: remediationSystem(WORKSPACE, failure),
		sandbox: new WorkspaceSandbox(WORKSPACE, BASH_MIN_TIMEOUT_SEC),
		tools: [makeBash(), fileEditor],
	});
}

// The prompt is the failure context + the marching order; all repo specifics live in AGENTS.md, which
// the system prompt tells the agent to read first.
const userPrompt = `The weekly minor-only dependency bump has been applied to package.json files across the repo and \`npm install\` has run. After that, ${failure}. Reproduce it, find the root cause in the upgraded dependency, and patch our source (not the version bumps) until \`npm run build\` and \`npm run test:e2e:local\` both pass. Follow the rules in your system prompt and in AGENTS.md.`;

// App-level throttle-retry around invoke() — the upper half of the two-layer defense. Only
// throttle/transient failures retry (isRetryableModelError); a terminal 4xx (bad role, validation)
// breaks out immediately instead of burning the whole backoff ladder.
let result: AgentResult | undefined;
let lastErr: unknown;
for (let attempt = 1; attempt <= INVOKE_MAX_ATTEMPTS; attempt++) {
	try {
		result = await makeRemediationAgent().invoke(userPrompt, { limits: { turns: MAX_TURNS } });
		break;
	} catch (err) {
		lastErr = err;
		const retryable = isRetryableModelError(err);
		process.stderr.write(
			`${LOG} agent.invoke attempt ${attempt}/${INVOKE_MAX_ATTEMPTS} failed (${retryable ? 'throttle/transient' : 'non-retryable'}): ${describeModelError(err)}\n`,
		);
		if (!retryable || attempt >= INVOKE_MAX_ATTEMPTS) break;
		const delayMs = nextBackoffMs(attempt);
		process.stderr.write(`${LOG} backing off ${Math.round(delayMs / 1000)}s before attempt ${attempt + 1}\n`);
		await sleep(delayMs);
	}
}

if (!result) {
	// The agent never ran (all Bedrock attempts failed or a config/role error). Fail hard: the workflow's
	// re-verify would fail anyway, but exiting 1 here surfaces the invoke failure as the distinct cause.
	process.stderr.write(`${LOG} agent.invoke failed after ${INVOKE_MAX_ATTEMPTS} attempt(s): ${describeModelError(lastErr)}\n`);
	process.exit(1);
}

process.stderr.write(
	`${LOG} done: stop=${result.stopReason} cycles=${result.metrics?.cycleCount ?? 0}\n${messageText(result.lastMessage)}\n`,
);

// Emit the agent's final summary to the GitHub step summary if available (best-effort), so a reviewer
// sees what the agent changed and why without digging through logs.
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
	try {
		writeFileSync(
			summaryPath,
			`### Dependency remediation agent\n\n**Trigger:** ${failure}\n\n**Model:** \`${MODEL_ID}\` · **Stop:** \`${result.stopReason}\` · **Cycles:** ${result.metrics?.cycleCount ?? 0}\n\n${messageText(result.lastMessage) || '_(no final message)_'}\n`,
			{ flag: 'a' },
		);
	} catch (err) {
		process.stderr.write(`${LOG} could not write step summary (non-fatal): ${describeError(err)}\n`);
	}
}

// Exit 0 regardless of the agent's own stop reason: the workflow's re-verify build + e2e steps are the
// authoritative gate on whether the remediation actually worked. A non-zero exit here would red the job
// before that gate even runs and mask the real (build/e2e) signal.
process.exit(0);

function messageText(msg: import('@strands-agents/sdk').Message | undefined): string {
	if (!msg) return '';
	return msg.content
		.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
		.filter(Boolean)
		.join('\n');
}
