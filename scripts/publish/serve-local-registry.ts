// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveRegistryRequest, upstreamRegistryUrl, UPSTREAM_REGISTRY } from "./local-registry.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const REGISTRY_DIR = join(ROOT, "dist-registry");
const PORT = 4873;

const server = createServer(async (req, res) => {
	// Decoding, the /index.json suffix and the containment check live in
	// resolveRegistryRequest (local-registry.ts) so they can be unit tested.
	const resolved = resolveRegistryRequest(REGISTRY_DIR, req.url ?? "/");

	if (!resolved) {
		res.writeHead(403, { "Content-Type": "text/plain" });
		res.end("Forbidden");
		return;
	}
	const { uri, filePath } = resolved;
	const contentType = uri.endsWith(".tgz") ? "application/gzip" : "application/json";

	let data: Buffer;
	try {
		data = await readFile(filePath);
	} catch {
		await serveFromUpstream(req.url ?? "/", uri, res);
		return;
	}
	res.writeHead(200, { "Content-Type": contentType });
	res.end(data);
});

/**
 * Forward a package this registry does not hold to the public registry, so a
 * caller can point npm's default `registry=` here instead of routing a single
 * scope. upstreamRegistryUrl decides what may be forwarded; a request it
 * refuses stays a 404.
 */
async function serveFromUpstream(
	rawUrl: string,
	uri: string,
	res: Parameters<Parameters<typeof createServer>[0]>[1],
): Promise<void> {
	const upstream = upstreamRegistryUrl(rawUrl);
	if (!upstream) {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end(`Not found: ${uri}`);
		return;
	}

	let response: Response;
	let body: Buffer;
	try {
		response = await fetch(upstream);
		// Read the body before any writeHead: if the upstream drops mid-body this
		// rejects, and a rejection after the head is sent cannot be answered with
		// a 502. Unhandled, it takes the whole registry process down, and every
		// later install in the run gets ECONNREFUSED instead of one failed fetch.
		body = Buffer.from(await response.arrayBuffer());
	} catch (err) {
		// An unreachable upstream must not read as "this package does not exist".
		res.writeHead(502, { "Content-Type": "text/plain" });
		res.end(`Upstream fetch failed for ${upstream}: ${err instanceof Error ? err.message : err}`);
		return;
	}

	res.writeHead(response.status, {
		"Content-Type": response.headers.get("content-type") ?? "application/octet-stream",
	});
	res.end(body);
}

server.listen(PORT, '127.0.0.1', () => {
	console.log(`Local registry serving at http://localhost:${PORT}/`);
	console.log(`Registry root: ${REGISTRY_DIR}`);
	console.log(`Upstream for every other package: ${UPSTREAM_REGISTRY}`);
	console.log(`\nTo test, create a project with this .npmrc:`);
	console.log(`  registry=http://localhost:${PORT}/registry/`);
	console.log(`\nPress Ctrl+C to stop.`);
});
