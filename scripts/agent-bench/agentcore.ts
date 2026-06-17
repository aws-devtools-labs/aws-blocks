/**
 * Thin async helpers around the two AgentCore Harness streaming operations
 * and the S3 transport we use to move bytes between runner and microVM.
 *
 * Three primitives, one per concern:
 *   exec(...)              shell command in the harness microVM → {stdout, stderr, exit}
 *   invokeAgent(...)       agent turn with system prompt + user text → {text, tokens, stop}
 *   putToTransport(...)    upload bytes to S3 under bench-uploads/* → returns the s3:// URI
 *
 * Nothing else in the bench should reach into the SDK directly.
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

// Default SDK read timeout is ~60s, which kills the stream during long-running
// exec commands (npm install, dnf install, playwright install). The agent
// itself can run for minutes too. Lift the per-request ceiling to 10min;
// individual exec calls still cap themselves via the `timeout` field in body.
const requestHandler = new NodeHttpHandler({
	requestTimeout: 600_000,
	connectionTimeout: 10_000,
});

const agentcore = new BedrockAgentCoreClient({ region: REGION, requestHandler });
const s3 = new S3Client({ region: REGION, requestHandler });

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

/**
 * Run a shell command inside the harness microVM. Streams stdout/stderr through
 * the response stream; this helper collects both and returns once the command
 * has stopped (`contentStop` event).
 *
 * `timeoutSec` is the in-microVM wall-clock cap. The SDK request itself uses
 * the 10-minute timeout configured on the client.
 */
export async function exec(
	harnessArn: string,
	sessionId: string,
	command: string,
	timeoutSec = 300,
): Promise<ExecResult> {
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
}

export interface InvokeOptions {
	systemPrompt: string;
	userText: string;
	modelId?: string;
	allowedTools?: string[];
	tools?: InvokeHarnessCommandInput['tools'];
}

/**
 * Invoke the harness agent for a single turn. Returns the final assistant text,
 * cumulative token usage, and stop reason.
 *
 * - `systemPrompt`/`userText` are plain strings; this fn handles the SDK shape.
 * - Omit `tools` and `allowedTools` to let the agent use all built-ins (shell +
 *   file_operations against the microVM).
 * - `allowedTools: ['file_operations']` removes shell access; file_operations
 *   itself is monolithic (view + create + edit). For a true read-only judge,
 *   `chmod -R a-w` the target directory before invoking and let the OS reject
 *   writes.
 * - `allowedTools: []` disables every built-in tool (pure text response).
 */
export async function invokeAgent(
	harnessArn: string,
	sessionId: string,
	opts: InvokeOptions,
): Promise<AgentResult> {
	const resp = await agentcore.send(
		new InvokeHarnessCommand({
			harnessArn,
			runtimeSessionId: sessionId,
			model: { bedrockModelConfig: { modelId: opts.modelId ?? 'us.anthropic.claude-sonnet-4-6' } },
			systemPrompt: [{ text: opts.systemPrompt }],
			messages: [{ role: 'user', content: [{ text: opts.userText }] }],
			...(opts.tools !== undefined ? { tools: opts.tools } : {}),
			...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
		}),
	);
	let text = '';
	let tokensIn = 0;
	let tokensOut = 0;
	let cacheReadTokens = 0;
	let stopReason = '';
	for await (const event of resp.stream ?? []) {
		if (event.contentBlockDelta?.delta?.text) text += event.contentBlockDelta.delta.text;
		if (event.messageStop?.stopReason) stopReason = event.messageStop.stopReason;
		if (event.metadata?.usage) {
			tokensIn += event.metadata.usage.inputTokens ?? 0;
			tokensOut += event.metadata.usage.outputTokens ?? 0;
			cacheReadTokens += event.metadata.usage.cacheReadInputTokens ?? 0;
		}
		if (event.runtimeClientError) {
			throw new Error(`harness error: ${event.runtimeClientError.message}`);
		}
	}
	return { text, tokensIn, tokensOut, stopReason, cacheReadTokens };
}

/**
 * Terminate a session promptly so the microVM is reclaimed. Without this, the
 * session sits warm until idleRuntimeSessionTimeout (configured per-harness;
 * default 900s). At ~150 cells/PR that's a real load on the per-account
 * 1,000-active-session quota.
 *
 * Best-effort — never throws. The orchestrator calls this in finally{}, and a
 * failed stop just lets the idle timer take over.
 */
export async function stopSession(harnessArn: string, sid: string): Promise<void> {
	try {
		await agentcore.send(
			new StopRuntimeSessionCommand({
				agentRuntimeArn: harnessArn,
				runtimeSessionId: sid,
			}),
		);
	} catch (err) {
		process.stderr.write(`[stopSession] non-fatal: ${(err as Error).message}\n`);
	}
}

/**
 * Build a runtime session ID that satisfies the API's >=33 char requirement.
 * The deterministic prefix is helpful when reading logs.
 */
export function sessionId(prefix: string): string {
	const padded = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	return padded.padEnd(33, 'x').slice(0, 64);
}

/**
 * Upload a buffer (or text body) to S3 under `bench-uploads/<runId>/<cellId>/<name>`
 * and return the s3:// URI. The microVM's exec role has `s3:GetObject` on this
 * prefix; the runner has `s3:PutObject`. Pair this with a single `aws s3 cp`
 * inside the microVM rather than streaming bytes through shell commands.
 */
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
