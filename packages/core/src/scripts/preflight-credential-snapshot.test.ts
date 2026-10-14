// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// A credential_process that issues credentials expiring in one minute. The SDK
// treats credentials that expire within five minutes as due for a refresh, so
// a second read from a client's credential provider runs this process again.
// After the first call it issues another key, or hangs, depending on the mode.
const CREDENTIAL_PROCESS = `
import { appendFileSync, readFileSync } from 'node:fs';
const [calls, mode] = process.argv.slice(2);
appendFileSync(calls, 'x');
if (readFileSync(calls, 'utf8').length > 1) {
  if (mode === 'hang') {
    // A real process that never answers, as a stuck MFA or sign-in tool would; it exits on its own so it cannot outlive the test.
    setTimeout(() => process.exit(1), 30_000);
  } else {
    console.log(JSON.stringify({ Version: 1, AccessKeyId: 'AKIDROTATEDKEY', SecretAccessKey: 's', SessionToken: 't',
      Expiration: new Date(Date.now() + 60_000).toISOString() }));
  }
} else {
  console.log(JSON.stringify({ Version: 1, AccessKeyId: 'AKIDFIRSTKEY', SecretAccessKey: 's', SessionToken: 't',
    Expiration: new Date(Date.now() + 60_000).toISOString() }));
}
`;

const preflightUrl = new URL('./preflight-credentials.js', import.meta.url).href;

describe('credentials for the metadata reads', () => {
	let directory: string;
	let server: Server;
	let url: string;
	let signedWith: string[];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'blocks-credential-snapshot-'));
		signedWith = [];
		// Stands in for STS, Account and Free Tier, and records the access key of each request.
		server = createServer((request, response) => {
			let body = '';
			request.on('data', (chunk) => {
				body += chunk;
			});
			request.on('end', () => {
				const key = /Credential=([^/]+)\//.exec(request.headers.authorization ?? '')?.[1];
				if (body.includes('GetCallerIdentity')) {
					signedWith.push(`sts:${key}`);
					response.writeHead(200, { 'content-type': 'text/xml' });
					response.end(
						'<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult>' +
							'<Arn>arn:aws:iam::123456789012:user/x</Arn><UserId>X</UserId><Account>123456789012</Account>' +
							'</GetCallerIdentityResult><ResponseMetadata><RequestId>1</RequestId></ResponseMetadata></GetCallerIdentityResponse>',
					);
				} else if (request.url?.includes('getAccountInformation')) {
					signedWith.push(`account:${key}`);
					response.writeHead(200, { 'content-type': 'application/json' });
					response.end(JSON.stringify({ AccountId: '123456789012', AccountName: 'Snapshot project' }));
				} else if (String(request.headers['x-amz-target']).includes('GetAccountPlanState')) {
					signedWith.push(`freetier:${key}`);
					response.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
					response.end(JSON.stringify({ accountPlanType: 'FREE', accountPlanStatus: 'ACTIVE' }));
				} else {
					response.writeHead(500);
					response.end();
				}
			});
		});
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		server.closeAllConnections();
		server.close();
		await once(server, 'close');
		await rm(directory, { recursive: true, force: true });
	});

	for (const mode of ['rotate', 'hang']) {
		it(`signs STS and the metadata reads with one credential snapshot when a near-expiry provider would ${mode}`, async () => {
			const script = join(directory, 'credential-process.mjs');
			const calls = join(directory, 'calls');
			await writeFile(script, CREDENTIAL_PROCESS);
			await writeFile(
				join(directory, 'config'),
				`[profile rotating]\nregion = eu-north-1\ncredential_process = "${process.execPath}" ${script} ${calls} ${mode}\n`,
			);
			await writeFile(join(directory, 'credentials'), '');
			const started = Date.now();
			const { stdout } = await execFileAsync(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`const { assertAwsCredentials } = await import(${JSON.stringify(preflightUrl)});
await assertAwsCredentials({ command: 'deploy', projectRoot: process.cwd() });`,
				],
				{
					cwd: directory,
					timeout: 20_000,
					env: {
						PATH: process.env.PATH,
						HOME: directory,
						USERPROFILE: directory,
						AWS_CONFIG_FILE: join(directory, 'config'),
						AWS_SHARED_CREDENTIALS_FILE: join(directory, 'credentials'),
						AWS_PROFILE: 'rotating',
						AWS_EC2_METADATA_DISABLED: 'true',
						AWS_ENDPOINT_URL_STS: url,
						AWS_ENDPOINT_URL_ACCOUNT: url,
						AWS_ENDPOINT_URL_FREETIER: url,
					},
				},
			);
			assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
			assert.equal((await readFile(calls, 'utf8')).length, 1, 'the credential process ran once');
			assert.deepEqual(signedWith.sort(), ['account:AKIDFIRSTKEY', 'freetier:AKIDFIRSTKEY', 'sts:AKIDFIRSTKEY']);
			assert.match(stdout, /Account name: Snapshot project$/m);
			assert.match(stdout, /Account plan: Free \(active\)$/m);
		});
	}
});
