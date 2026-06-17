/**
 * Pre-run check. Verifies the bench has everything it needs to run, with the
 * minimum permissions the runner is granted (invoke-only — no create, no get).
 *
 * Runs four probes in sequence; the first failure aborts:
 *   1. env: required variables are set
 *   2. harness: a 1-turn invokeAgent smoke (proves InvokeHarness + IAM + model access)
 *   3. exec:    a 1-line invokeAgentRuntimeCommand (proves microVM access)
 *   4. s3:      a no-op aws s3 ls on the transport prefix (proves transport bucket + role)
 *
 * Designed to run *first* in CI. If preflight is green, the bench will run.
 * If preflight is red, the failure message tells you which knob to turn.
 *
 * Required env:
 *   BENCH_HARNESS_ARN        the harness ARN
 *   BENCH_TRANSPORT_BUCKET   the S3 bucket the runner uploads tarballs to
 *   AWS_REGION               defaults to us-east-1
 */
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { exec, invokeAgent, sessionId } from './agentcore.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';

interface Check {
	name: string;
	fn: () => Promise<void>;
}

function checkEnv(): void {
	const required = ['BENCH_HARNESS_ARN', 'BENCH_TRANSPORT_BUCKET'];
	const missing = required.filter((name) => !process.env[name]);
	if (missing.length) {
		throw new Error(`missing required env var(s): ${missing.join(', ')}`);
	}
}

async function checkHarness(harnessArn: string): Promise<void> {
	const sid = sessionId('preflight');
	const r = await invokeAgent(harnessArn, sid, {
		systemPrompt: 'You are a connectivity probe. Answer in two words or fewer.',
		userText: 'Reply with: ok',
		allowedTools: [],
	});
	if (!r.text.toLowerCase().includes('ok')) {
		throw new Error(`harness invokeAgent did not return 'ok' (got: ${r.text.slice(0, 100)!})`);
	}
	process.stderr.write(`  → invokeAgent ok (in=${r.tokensIn}, out=${r.tokensOut})\n`);
}

async function checkExec(harnessArn: string): Promise<void> {
	const sid = sessionId('preflight-exec');
	const r = await exec(harnessArn, sid, 'echo bench-preflight-ok && uname -m');
	if (r.exitCode !== 0 || !r.stdout.includes('bench-preflight-ok')) {
		throw new Error(`exec smoke failed (exit ${r.exitCode}): ${r.stdout}${r.stderr}`);
	}
	process.stderr.write(`  → exec ok (arch=${r.stdout.split('\n')[1]?.trim()})\n`);
}

async function checkS3(bucket: string): Promise<void> {
	// List the prefix; HEAD on a fixed key would also work but list works even when
	// the prefix is empty. We need ListBucket-on-prefix? No — ListObjectsV2 needs
	// s3:ListBucket on the bucket, which the runner does have via the existing
	// CDK construct. (The microVM exec role only needs GetObject; not exercised here.)
	await s3List(bucket);
	process.stderr.write(`  → s3 transport bucket reachable: s3://${bucket}/bench-uploads/\n`);
}

async function s3List(bucket: string): Promise<void> {
	const client = new S3Client({ region: REGION });
	await client.send(
		new ListObjectsV2Command({
			Bucket: bucket,
			Prefix: 'bench-uploads/',
			MaxKeys: 1,
		}),
	);
}

async function main() {
	const harnessArn = process.env.BENCH_HARNESS_ARN ?? '';
	const transportBucket = process.env.BENCH_TRANSPORT_BUCKET ?? '';

	const checks: Check[] = [
		{ name: 'env', fn: async () => checkEnv() },
		{ name: 'harness invokeAgent', fn: () => checkHarness(harnessArn) },
		{ name: 'harness exec', fn: () => checkExec(harnessArn) },
		{ name: 's3 transport', fn: () => checkS3(transportBucket) },
	];

	for (const c of checks) {
		process.stderr.write(`[preflight] ${c.name}\n`);
		try {
			await c.fn();
		} catch (err) {
			process.stderr.write(`[preflight] FAIL: ${c.name}: ${(err as Error).message}\n`);
			process.exit(1);
		}
	}

	process.stderr.write(`[preflight] all checks passed\n`);
}

main().catch((err) => {
	process.stderr.write(`[preflight] fatal: ${err.stack ?? err}\n`);
	process.exit(1);
});
