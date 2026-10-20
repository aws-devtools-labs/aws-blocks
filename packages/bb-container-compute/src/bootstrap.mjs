// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Container boot entry — fetch the app bundles from S3, then exec the parent.
 *
 * WHY THIS EXISTS
 * ---------------
 * The container compute deploys with NO local Docker build: it runs a stock
 * public Node image (`public.ecr.aws/docker/library/node:24-slim` by default, or
 * the customer's `image`) verbatim, and the application code (`main.js` +
 * `worker.js`) is shipped separately as an S3 asset. A task command override runs
 * this script at boot; it downloads both bundles to `/app` and execs
 * `node /app/main.js`.
 *
 * HARD CONSTRAINT: this file runs BEFORE the app bundles exist on disk, on a
 * stock Node image that has no AWS CLI, no curl, and no `@aws-sdk/*`. So it must
 * use ONLY Node built-ins. It is therefore NOT esbuilt — it is copied verbatim
 * into the asset (see bundle.ts). Authentication uses the ECS task role via the
 * container credentials endpoint + a minimal SigV4 signer over `node:https`.
 *
 * This is the canonical ECS pattern: a generic image + an entrypoint/command
 * override that fetches what it needs using the task IAM role. The role's
 * credentials are served fresh at every container start (reboot, autoscale,
 * crash-replacement), so there is no deploy-time-only credential and nothing to
 * expire. See:
 *   https://docs.aws.amazon.com/sdkref/latest/guide/feature-container-credentials.html
 *   https://containersonaws.com/pattern/ecs-entrypoint-command-task-definition/
 *
 * CONTRACT (env vars set by the CDK task definition):
 *   BLOCKS_CODE_BUCKET   S3 bucket holding the asset
 *   BLOCKS_CODE_PREFIX   key prefix of the uploaded asset (dir), bundles live under it
 *   AWS_REGION           region of the bucket (set by ECS)
 *   AWS_CONTAINER_CREDENTIALS_RELATIVE_URI   task-role creds endpoint (set by ECS)
 */
import { createHash, createHmac } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { spawn } from 'node:child_process';

const APP_DIR = '/app';
const CREDS_HOST = '169.254.170.2'; // ECS task metadata/credentials link-local address

/** Minimal GET over http (used only for the link-local credentials endpoint). */
function fetchJson(url) {
	return new Promise((resolve, reject) => {
		httpGet(url, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => {
				if ((res.statusCode ?? 0) >= 300) {
					reject(new Error(`credentials endpoint returned ${res.statusCode}`));
					return;
				}
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
				} catch (e) {
					reject(e);
				}
			});
		}).on('error', reject);
	});
}

/** Read task-role credentials from the ECS container credentials endpoint. */
async function getTaskCredentials() {
	const rel = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
	const full = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
	if (!rel && !full) {
		throw new Error(
			'[Blocks bootstrap] no ECS container credentials endpoint — AWS_CONTAINER_CREDENTIALS_RELATIVE_URI/FULL_URI unset. ' +
				'This script expects to run as an ECS task with a task role.',
		);
	}
	const url = full ?? `http://${CREDS_HOST}${rel}`;
	const creds = await fetchJson(url);
	return {
		accessKeyId: creds.AccessKeyId,
		secretAccessKey: creds.SecretAccessKey,
		sessionToken: creds.Token,
	};
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** Derive the SigV4 signing key for a given date/region/service. */
function signingKey(secret, dateStamp, region, service) {
	const kDate = hmac(`AWS4${secret}`, dateStamp);
	const kRegion = hmac(kDate, region);
	const kService = hmac(kRegion, service);
	return hmac(kService, 'aws4_request');
}

/**
 * GET an S3 object with SigV4 (service `s3`, unsigned-payload) using task-role
 * credentials. Returns the body as a Buffer. No dependencies beyond node:crypto
 * and node:https.
 */
function s3Get(bucket, key, region, creds) {
	return new Promise((resolve, reject) => {
		const host = `${bucket}.s3.${region}.amazonaws.com`;
		// S3 wants each path segment encoded but slashes preserved.
		const canonicalUri = `/${key.split('/').map(encodeURIComponent).join('/')}`;

		const now = new Date();
		const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
		const dateStamp = amzDate.slice(0, 8);
		const payloadHash = 'UNSIGNED-PAYLOAD';

		const headers = {
			host,
			'x-amz-content-sha256': payloadHash,
			'x-amz-date': amzDate,
		};
		if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;

		const signedHeaders = Object.keys(headers).sort().join(';');
		const canonicalHeaders = `${Object.keys(headers)
			.sort()
			.map((h) => `${h}:${headers[h]}`)
			.join('\n')}\n`;

		const canonicalRequest = [
			'GET',
			canonicalUri,
			'', // no query string
			canonicalHeaders,
			signedHeaders,
			payloadHash,
		].join('\n');

		const scope = `${dateStamp}/${region}/s3/aws4_request`;
		const stringToSign = [
			'AWS4-HMAC-SHA256',
			amzDate,
			scope,
			sha256Hex(canonicalRequest),
		].join('\n');

		const signature = hmac(signingKey(creds.secretAccessKey, dateStamp, region, 's3'), stringToSign).toString('hex');

		const authorization =
			`AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
			`SignedHeaders=${signedHeaders}, Signature=${signature}`;

		const req = httpsRequest(
			{ method: 'GET', host, path: canonicalUri, headers: { ...headers, Authorization: authorization } },
			(res) => {
				const chunks = [];
				res.on('data', (c) => chunks.push(c));
				res.on('end', () => {
					if ((res.statusCode ?? 0) >= 300) {
						reject(new Error(`S3 GET ${key} returned ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`));
						return;
					}
					resolve(Buffer.concat(chunks));
				});
			},
		);
		req.on('error', reject);
		req.end();
	});
}

async function main() {
	const bucket = process.env.BLOCKS_CODE_BUCKET;
	const prefix = process.env.BLOCKS_CODE_PREFIX;
	const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
	if (!bucket || !prefix || !region) {
		throw new Error(
			`[Blocks bootstrap] missing config: BLOCKS_CODE_BUCKET=${bucket} BLOCKS_CODE_PREFIX=${prefix} AWS_REGION=${region}`,
		);
	}

	const creds = await getTaskCredentials();
	mkdirSync(APP_DIR, { recursive: true });

	// Fetch the three asset files the parent/worker need. package.json pins CJS
	// mode for the .js bundles.
	for (const name of ['main.js', 'worker.js', 'package.json']) {
		const key = `${prefix.replace(/\/$/, '')}/${name}`;
		const body = await s3Get(bucket, key, region, creds);
		writeFileSync(`${APP_DIR}/${name}`, body);
	}

	console.log('[Blocks bootstrap] app bundles fetched; starting parent process');

	// Exec the parent. Inherit stdio so container logs flow to the awslogs driver,
	// and forward signals so ECS task stop drains gracefully.
	const child = spawn(process.execPath, [`${APP_DIR}/main.js`], { stdio: 'inherit', env: process.env });
	const forward = (sig) => () => child.kill(sig);
	process.on('SIGTERM', forward('SIGTERM'));
	process.on('SIGINT', forward('SIGINT'));
	child.on('exit', (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
}

main().catch((err) => {
	console.error('[Blocks bootstrap] fatal:', err);
	process.exit(1);
});
