// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Publish the @aws-blocks/* packages to npm.
 *
 *   tsx scripts/publish/publish-npm.ts            # live: changeset publish (skips versions already on npm)
 *   tsx scripts/publish/publish-npm.ts --dry-run  # pack & validate workspaces locally, no registry contact
 *
 * Private workspaces (test-apps, template `aws-blocks` dirs) are skipped by npm automatically.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

const dryRun = process.argv.includes("--dry-run");

if (!dryRun && !process.env.NODE_AUTH_TOKEN) {
	console.error("✗ Real publish requested but NODE_AUTH_TOKEN is not set.");
	process.exit(1);
}

console.log(`AWS Blocks Publish — npm (${dryRun ? "dry-run" : "LIVE"})\n`);

if (dryRun) {
	execFileSync("npm", ["publish", "--workspaces", "--access=public", "--dry-run"], {
		cwd: ROOT,
		stdio: "inherit",
	});
} else {
	// access comes from .changeset/config.json; provenance via NPM_CONFIG_PROVENANCE in CI.
	execFileSync("npx", ["changeset", "publish"], { cwd: ROOT, stdio: "inherit" });
}
