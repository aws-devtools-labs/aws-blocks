// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? '/opt/registry');
const ledger = process.argv[3] ?? '/var/lib/harbor-verifier/registry-requests.jsonl';
const UPSTREAM = 'https://registry.npmjs.org';
// Same packed metadata layout as scripts/publish/serve-local-registry.ts, and the same split: this
// run's candidate packages are served from /opt/registry or 404, never fetched from public npm, so
// a missing one stays a real installation failure. Everything else is forwarded upstream, which is
// what lets the bench npmrc set the DEFAULT registry here — npm resolves a registry per scope, so a
// scope line cannot route the unscoped `aws-cdk-blocks` umbrella.
const isCandidate = (name) =>
	name.startsWith('@aws-cdk-blocks/') || name === 'aws-cdk-blocks' || name.startsWith('aws-cdk-blocks/');
createServer(async (request, response) => {
	let uri;
	try {
		uri = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
	} catch {
		response.writeHead(404).end();
		return;
	}
	if (!uri.startsWith('/registry/')) {
		response.writeHead(404).end();
		return;
	}
	const name = uri.slice('/registry/'.length);

	if (isCandidate(name)) {
		try {
			const file = resolve(root, `.${uri}${uri.endsWith('.tgz') ? '' : '/index.json'}`);
			if (!file.startsWith(`${root}${sep}`)) {
				response.writeHead(404).end();
				return;
			}
			const data = await readFile(file);
			await appendFile(ledger, `${JSON.stringify({ path: uri, time: new Date().toISOString() })}\n`);
			response.writeHead(200, { 'content-type': uri.endsWith('.tgz') ? 'application/gzip' : 'application/json' });
			response.end(data);
		} catch {
			response.writeHead(404).end();
		}
		return;
	}

	// A package name never begins with a path separator and never contains `..`. A leading
	// separator makes the remainder an authority and moves the request to another host:
	// `//evil` and `\\evil` both do it, as do their encoded forms, so the decoded name is
	// checked as well as the raw path. Same guard as scripts/publish/local-registry.ts.
	const rawPath = request.url.slice('/registry/'.length);
	if (/^[/\\]/.test(rawPath) || /^[/\\]/.test(name) || name.includes('..')) {
		response.writeHead(404).end();
		return;
	}
	let forwarded;
	try {
		forwarded = new URL(rawPath, `${UPSTREAM}/`);
	} catch {
		response.writeHead(404).end();
		return;
	}
	if (forwarded.origin !== new URL(`${UPSTREAM}/`).origin) {
		response.writeHead(404).end();
		return;
	}
	try {
		const upstream = await fetch(`${UPSTREAM}/${rawPath}`);
		// Read the body before writeHead: a mid-body disconnect rejects here, and calling
		// writeHead(502) after the head is already sent throws ERR_HTTP_HEADERS_SENT inside
		// the catch. Unhandled, that takes the registry down and the rest of the trial's
		// installs get connection refused, which reads as the agent's failure.
		const body = Buffer.from(await upstream.arrayBuffer());
		response.writeHead(upstream.status, {
			'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
		});
		response.end(body);
	} catch {
		// An unreachable upstream must not read as "this package does not exist".
		if (response.headersSent) response.destroy();
		else response.writeHead(502).end();
	}
}).listen(4873, '127.0.0.1');
