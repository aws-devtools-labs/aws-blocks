// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Probe for `test-support-secret.test.ts`, run under `tsx -C browser` exactly
 * like the e2e harness. Usage: `test-support-secret.probe.ts <mode> <workDir> <outFile>`.
 *
 * - `harness`: from `workDir` (which holds `.blocks-sandbox/outputs.json` or
 *   `.bb-data/settings.json`), call the harness's `readTestSupportSecret()`.
 * - `in-process`: read the parameter with the AWS SDK in this process, as the
 *   harness did before FX52 — the call that failed on the sandbox.
 *
 * Writes `{ ok: true, secret }` or `{ ok: false, name, message }` to `outFile`,
 * and prints nothing, so the test can check the secret never reaches a log.
 */

import { writeFileSync } from 'node:fs';

const [mode, workDir, outFile] = process.argv.slice(2);
if (!mode || !workDir || !outFile) throw new Error('usage: test-support-secret.probe.ts <mode> <workDir> <outFile>');

async function read(): Promise<string> {
	if (mode === 'harness') {
		process.chdir(workDir);
		const { readTestSupportSecret } = await import('./test-support.js');
		return await readTestSupportSecret();
	}
	if (mode === 'in-process') {
		const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
		const out = await new SSMClient({}).send(new GetParameterCommand({ Name: 'unused', WithDecryption: true }));
		return out.Parameter?.Value ?? '';
	}
	throw new Error(`unknown mode ${mode}`);
}

try {
	writeFileSync(outFile, JSON.stringify({ ok: true, secret: await read() }));
} catch (err) {
	const { name, message } = err instanceof Error ? err : new Error(String(err));
	writeFileSync(outFile, JSON.stringify({ ok: false, name, message }));
}
