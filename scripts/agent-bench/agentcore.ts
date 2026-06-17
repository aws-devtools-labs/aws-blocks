/**
 * Thin async wrappers around AgentCore Harness streaming + S3 transport.
 *
 *   exec              — shell command in the harness microVM
 *   invokeAgent       — agent turn (handles inline tool_use loop internally)
 *   putToTransport    — S3 upload under bench-uploads/<runId>/<cellId>/
 *   sessionId         — runtime session ID with the API's >=33 char shape
 *   stopSession       — best-effort cleanup
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
	BedrockAgentCoreClient,
	InvokeAgentRuntimeCommandCommand,
	InvokeHarnessCommand,
	StopRuntimeSessionCommand,
	type InvokeHarnessCommandInput,
} from '@aws-sdk/client-bedrock-agentcore';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export const REGION = process.env.AWS_REGION ?? 'us-east-1';

// SDK default read timeout is ~60s, which kills long exec streams (npm install,
// playwright install) and multi-minute agent turns. 10min ceiling.
const requestHandler = new NodeHttpHandler({ requestTimeout: 600_000, connectionTimeout: 10_000 });
const agentcore = new BedrockAgentCoreClient({ region: REGION, requestHandler });
const s3 = new S3Client({ region: REGION, requestHandler });

// 3 attempts catches blip-style HTML responses from the harness; sustained
// outages surface honestly as cell errors. Don't retry 4xx (config bugs).
const MAX_RETRY_ATTEMPTS = 3;

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
			const status = e.$metadata?.httpStatusCode;
			const message = e.message ?? '';
			const transient =
				message.includes('Unexpected token') ||
				message.includes('Deserialization error') ||
				e.name === 'ThrottlingException' ||
				e.name === 'ServiceUnavailableException' ||
				e.name === 'InternalServerException' ||
				(status != null && status >= 500);
			if (!transient || attempt === MAX_RETRY_ATTEMPTS - 1) throw err;
			const delayMs = 2_000 * 2 ** attempt + Math.floor(Math.random() * 500);
			process.stderr.write(
				`[${label}] transient error (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}): ${e.name ?? ''} ${message.slice(0, 120)} — retrying in ${delayMs}ms\n`,
			);
			await new Promise((r) => setTimeout(r, delayMs));
		}
	}
	throw lastErr;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface AgentResult {
	text: string;
	tokensIn: number;
	tokensOut: number;
	stopReason: string;
	cacheReadTokens: number;
}

export async function exec(
	harnessArn: string,
	sessionId: string,
	command: string,
	timeoutSec = 300,
): Promise<ExecResult> {
	return withRetry('exec', async () => {
		const resp = await agentcore.send(
			new InvokeAgentRuntimeCommandCommand({
				agentRuntimeArn: harnessArn,
				runtimeSessionId: sessionId,
				body: { command, timeout: timeoutSec },
			}),
		);
		let stdout = '';
		let stderr = '';
		let exitCode = 0;
		for await (const event of resp.stream ?? []) {
			const chunk = event.chunk;
			if (!chunk) continue;
			if (chunk.contentDelta?.stdout) stdout += chunk.contentDelta.stdout;
			if (chunk.contentDelta?.stderr) stderr += chunk.contentDelta.stderr;
			if (chunk.contentStop?.exitCode != null) exitCode = chunk.contentStop.exitCode;
		}
		return { stdout, stderr, exitCode };
	});
}

export interface InvokeOptions {
	systemPrompt: string;
	userText: string;
	modelId?: string;
	allowedTools?: string[];
	tools?: InvokeHarnessCommandInput['tools'];
	// Cap the agent loop. The harness has its own default; setting this
	// explicitly per-call is an Anthropic-recommended stopping condition for
	// long-running tasks. 200 is plenty for our task shape (typical builder run
	// uses ~30-60 iterations).
	maxIterations?: number;
	// Per-iteration token cap. Useful for the judge: a 4K cap forces concise
	// JSON output and surfaces malformed responses as max_tokens fast instead
	// of waiting for streaming to finish.
	maxTokens?: number;
	// Wall-clock cap on the agent loop in seconds. The orchestrator's own
	// timeout is the SDK request timeout (10min); this is a softer agent-side
	// cap so the harness can stop cleanly.
	timeoutSeconds?: number;
}

// HarnessStopReason enum (from @aws-sdk/client-bedrock-agentcore):
//   end_turn, max_iterations_exceeded, max_output_tokens_exceeded, max_tokens,
//   model_context_window_exceeded, timeout_exceeded, content_filtered,
//   stop_sequence, interrupted, partial_turn, tool_use, tool_result,
//   malformed_model_output, malformed_tool_use
//
// We declare zero inline tools — the agent's toolset is shell + file_operations
// only. The harness can still surface tool_use, malformed_tool_use, or
// partial_turn back to the client; we recover by replying with a brief
// guidance message and reinvoking. Up to 5 recovery turns.
const MAX_RECOVERY_TURNS = 5;

const RECOVERABLE_STOP_REASONS = new Set([
	'tool_use', // inline tool surfaced (model hallucinated tool name or harness leak)
	'malformed_tool_use', // tool input wasn't parseable JSON
	'partial_turn', // turn cut short before end_turn — re-prompt to continue
	'malformed_model_output', // streaming output couldn't be parsed
]);

interface ToolUseFragment {
	toolUseId: string;
	name: string;
	input: string;
}

interface ContentBlock {
	text?: string;
	toolUse?: { toolUseId: string; name: string; input: unknown };
	toolResult?: { toolUseId: string; content: { text: string }[]; status: 'success' | 'error' };
}

interface AgentMessage {
	role: 'user' | 'assistant';
	content: ContentBlock[];
}

export async function invokeAgent(harnessArn: string, sessionId: string, opts: InvokeOptions): Promise<AgentResult> {
	let messages: AgentMessage[] = [{ role: 'user', content: [{ text: opts.userText }] }];
	let aggText = '';
	let tokensIn = 0;
	let tokensOut = 0;
	let cacheReadTokens = 0;
	let stopReason = '';

	for (let turn = 0; turn < MAX_RECOVERY_TURNS; turn++) {
		const r = await withRetry('invokeAgent', () => singleTurn(harnessArn, sessionId, opts, messages));
		aggText += r.text;
		tokensIn += r.tokensIn;
		tokensOut += r.tokensOut;
		cacheReadTokens += r.cacheReadTokens;
		stopReason = r.stopReason;

		const recoverable = RECOVERABLE_STOP_REASONS.has(stopReason);
		if (!recoverable || turn === MAX_RECOVERY_TURNS - 1) break;

		// Build the recovery message based on which stop reason we hit.
		if ((stopReason === 'tool_use' || stopReason === 'malformed_tool_use') && r.toolUses.length > 0) {
			const guidance =
				stopReason === 'malformed_tool_use'
					? 'Your last tool call had malformed input (not valid JSON). Re-emit it with proper JSON, or use shell/file_operations directly.'
					: `No inline tool named "${r.toolUses.map((t) => t.name).join(',')}" is declared. Use the built-in shell or file_operations tools, or finish with end_turn.`;
			messages = [
				{
					role: 'assistant',
					content: r.toolUses.map((tu) => ({
						toolUse: { toolUseId: tu.toolUseId, name: tu.name, input: safeJson(tu.input) },
					})),
				},
				{
					role: 'user',
					content: r.toolUses.map((tu) => ({
						toolResult: {
							toolUseId: tu.toolUseId,
							content: [{ text: guidance }],
							status: 'error' as const,
						},
					})),
				},
			];
		} else {
			// partial_turn or malformed_model_output — re-prompt with a nudge to
			// continue. No assistant toolUse to echo back.
			messages = [
				{
					role: 'user',
					content: [
						{
							text: `Your previous turn ended with stop_reason=${stopReason} before completing. Continue from where you left off. If your work is done, run \`npm run build\` to confirm it passes and end with end_turn.`,
						},
					],
				},
			];
		}
		process.stderr.write(
			`[invokeAgent] recoverable stop_reason=${stopReason} — re-prompting (turn ${turn + 1}/${MAX_RECOVERY_TURNS})\n`,
		);
	}

	return { text: aggText, tokensIn, tokensOut, stopReason, cacheReadTokens };
}

function safeJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return {};
	}
}

interface SingleTurnResult {
	text: string;
	tokensIn: number;
	tokensOut: number;
	cacheReadTokens: number;
	stopReason: string;
	toolUses: ToolUseFragment[];
}

async function singleTurn(
	harnessArn: string,
	sessionId: string,
	opts: InvokeOptions,
	messages: AgentMessage[],
): Promise<SingleTurnResult> {
	const resp = await agentcore.send(
		new InvokeHarnessCommand({
			harnessArn,
			runtimeSessionId: sessionId,
			model: { bedrockModelConfig: { modelId: opts.modelId ?? 'us.anthropic.claude-sonnet-4-6' } },
			systemPrompt: [{ text: opts.systemPrompt }],
			messages: messages as unknown as InvokeHarnessCommandInput['messages'],
			...(opts.tools !== undefined ? { tools: opts.tools } : {}),
			...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
			...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
			...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
			...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
		}),
	);
	let text = '';
	let tokensIn = 0;
	let tokensOut = 0;
	let cacheReadTokens = 0;
	let stopReason = '';
	const toolUses: ToolUseFragment[] = [];
	let activeToolIndex = -1;
	for await (const event of resp.stream ?? []) {
		const start = event.contentBlockStart?.start as
			| { toolUse?: { toolUseId?: string; name?: string } }
			| undefined;
		if (start?.toolUse?.toolUseId && start.toolUse.name) {
			toolUses.push({ toolUseId: start.toolUse.toolUseId, name: start.toolUse.name, input: '' });
			activeToolIndex = toolUses.length - 1;
		}
		if (event.contentBlockDelta?.delta?.text) text += event.contentBlockDelta.delta.text;
		const toolDelta = (event.contentBlockDelta?.delta as { toolUse?: { input?: string } } | undefined)?.toolUse;
		if (toolDelta?.input != null && activeToolIndex >= 0) toolUses[activeToolIndex].input += toolDelta.input;
		if (event.contentBlockStop) activeToolIndex = -1;
		if (event.messageStop?.stopReason) stopReason = event.messageStop.stopReason;
		if (event.metadata?.usage) {
			tokensIn += event.metadata.usage.inputTokens ?? 0;
			tokensOut += event.metadata.usage.outputTokens ?? 0;
			cacheReadTokens += event.metadata.usage.cacheReadInputTokens ?? 0;
		}
		if (event.runtimeClientError) throw new Error(`harness error: ${event.runtimeClientError.message}`);
	}
	return { text, tokensIn, tokensOut, cacheReadTokens, stopReason, toolUses };
}

export async function stopSession(harnessArn: string, sid: string): Promise<void> {
	try {
		await agentcore.send(new StopRuntimeSessionCommand({ agentRuntimeArn: harnessArn, runtimeSessionId: sid }));
	} catch (err) {
		process.stderr.write(`[stopSession] non-fatal: ${(err as Error).message}\n`);
	}
}

export function sessionId(prefix: string): string {
	const padded = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	return padded.padEnd(33, 'x').slice(0, 64);
}

export async function putToTransport(args: {
	bucket: string;
	runId: string;
	cellId: string;
	name: string;
	body: Buffer | string;
	contentType?: string;
}): Promise<string> {
	const key = `bench-uploads/${args.runId}/${args.cellId}/${args.name}`;
	await s3.send(
		new PutObjectCommand({
			Bucket: args.bucket,
			Key: key,
			Body: args.body,
			ContentType: args.contentType ?? 'application/octet-stream',
		}),
	);
	return `s3://${args.bucket}/${key}`;
}
