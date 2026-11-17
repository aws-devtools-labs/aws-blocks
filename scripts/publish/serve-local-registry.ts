// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveRegistryRequest } from "./local-registry.ts";

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

	try {
		const data = await readFile(filePath);
		res.writeHead(200, { "Content-Type": contentType });
		res.end(data);
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end(`Not found: ${uri}`);
	}
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`Local registry serving at http://localhost:${PORT}/`);
	console.log(`Registry root: ${REGISTRY_DIR}`);
	console.log(`\nTo test, create a project with this .npmrc:`);
	console.log(`  @aws-blocks:registry=http://localhost:${PORT}/registry/`);
	console.log(`\nPress Ctrl+C to stop.`);
});
