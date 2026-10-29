// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? '/opt/registry');
const ledger = process.argv[3] ?? '/var/lib/harbor-verifier/registry-requests.jsonl';
// Same packed metadata layout as scripts/publish/serve-local-registry.ts. No public
// fallback for @aws-blocks: a missing candidate package is a real installation failure.
createServer(async (request, response) => {
	try {
		const uri = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
		const file = resolve(root, `.${uri}${uri.endsWith('.tgz') ? '' : '/index.json'}`);
		if (!file.startsWith(`${root}${sep}`) || !uri.startsWith('/registry/@aws-blocks/')) {
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
}).listen(4873, '127.0.0.1');
