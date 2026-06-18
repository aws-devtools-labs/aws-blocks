// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate the packaging contract of every publishable @aws-blocks/* package:
 *
 *   - publint                 audits package.json (exports order, file extensions,
 *                             main/module/types fields) against the built output.
 *   - @arethetypeswrong/cli   runs the packed tarball through every TypeScript
 *                             module-resolution mode and reports where consumers
 *                             would get wrong or missing types.
 *
 * Run on its own:   tsx scripts/publish/validate-exports.ts
 * Also runs as part of the publish dry-run (see publish-npm.ts).
 *
 * Both tools are invoked via `npx --yes` so they stay out of the dependency tree.
 *
 * ESM-only stance: these packages ship ESM only. attw therefore flags two
 * conditions on every package *by design*, and we ignore them:
 *   - no-resolution        node10 (legacy, pre-"exports") cannot resolve them.
 *   - cjs-resolves-to-esm  a CJS `require()` lands on an ESM file; consumers
 *                          must use dynamic import. This is intended, not a bug.
 * Every other attw rule (type masquerading, missing types, etc.) stays strict.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const PACKAGES_DIR = resolve(ROOT, "packages");

const ATTW_IGNORED_RULES = ["cjs-resolves-to-esm", "no-resolution"];

type Pkg = { name: string; dir: string; hasEntry: boolean };

function publishablePackages(): Pkg[] {
	const pkgs: Pkg[] = [];
	for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = resolve(PACKAGES_DIR, entry.name);
		let json: Record<string, unknown>;
		try {
			json = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
		} catch {
			continue;
		}
		if (json.private) continue;
		pkgs.push({
			name: json.name as string,
			dir,
			// Bin-only packages (e.g. create-blocks-app) have no importable surface,
			// so attw's type-resolution checks don't apply to them.
			hasEntry: Boolean(json.exports) || Boolean(json.main),
		});
	}
	return pkgs.sort((a, b) => a.name.localeCompare(b.name));
}

function run(cmd: string, args: string[], cwd: string): boolean {
	try {
		execFileSync(cmd, args, { cwd, stdio: "inherit" });
		return true;
	} catch {
		return false;
	}
}

const packages = publishablePackages();
console.log(`Validating packaging for ${packages.length} publishable packages\n`);

const failures: string[] = [];

for (const pkg of packages) {
	console.log(`\n──────── ${pkg.name} ────────`);

	// Default level (not --strict): fail on errors only. Warnings/suggestions
	// (e.g. missing engines.node) are printed but don't block a publish.
	console.log("• publint");
	if (!run("npx", ["--yes", "publint"], pkg.dir)) {
		failures.push(`${pkg.name} (publint)`);
	}

	if (pkg.hasEntry) {
		console.log("• @arethetypeswrong/cli");
		const attwArgs = ["--yes", "@arethetypeswrong/cli", "--pack", "--ignore-rules", ...ATTW_IGNORED_RULES];
		if (!run("npx", attwArgs, pkg.dir)) {
			failures.push(`${pkg.name} (attw)`);
		}
	} else {
		console.log("• @arethetypeswrong/cli — skipped (no importable entry)");
	}
}

console.log(`\n${"═".repeat(48)}`);
if (failures.length > 0) {
	console.error(`✗ Packaging validation failed for ${failures.length} check(s):`);
	for (const f of failures) console.error(`   - ${f}`);
	process.exit(1);
}
console.log(`✓ All ${packages.length} packages pass packaging validation.`);
