// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keyword guard used in CI.
 *
 *   verify-discovery-tag  Exit non-zero if any publishable `@aws-blocks/*`
 *                   package omits the `aws-blocks` keyword from its
 *                   package.json. That keyword is the documented discovery
 *                   path — `npm search keywords:aws-blocks`
 *                   (docs/guides/extending-with-existing-aws-resources.md) —
 *                   and it is invisible at review time: a new Building Block
 *                   builds, tests and publishes perfectly well without it,
 *                   and simply never shows up in the search the docs promise.
 *                   That is exactly how #491 happened (every published package
 *                   was missing the tag), so the invariant is asserted here
 *                   rather than left to reviewers.
 *
 * A package counts as publishable when it lives in packages/, is not
 * `private: true`, and its name is under the `@aws-blocks/` scope — the same
 * rule the changeset coverage guard applies. Everything else (the private
 * `foundations` workspace, test-apps, create-blocks-app templates, native
 * clients, scripts) is never published to npm and so is not checked.
 *
 * The guard fails loudly. When it cannot read what it asserts against (a
 * missing or malformed package.json, say) it exits non-zero with the reason
 * instead of printing a green line it did not earn.
 *
 * Usage:
 *   node --experimental-strip-types scripts/keywords-guard.ts verify-discovery-tag
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const SCOPE = "@aws-blocks/";
const DISCOVERY_KEYWORD = "aws-blocks";

/**
 * The guard could not evaluate what it was asked to assert. Reported as a normal
 * failure (exit 1) with the reason, never swallowed.
 */
class GuardError extends Error {}

/** Parse a JSON file, failing the guard loudly if it is unreadable or invalid. */
function readJson(path: string, label: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err) {
		throw new GuardError(`Cannot read ${label} (${path}): ${(err as Error).message}`);
	}
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new GuardError(`Cannot parse ${label} (${path}) as JSON: ${(err as Error).message}`);
	}
}

interface PublishablePackage {
	name: string;
	dir: string;
	keywords: string[];
}

/**
 * Every publishable `@aws-blocks/*` package under packages/, with its declared
 * keywords. A `keywords` that is absent or not an array yields an empty list, so
 * the package is reported as missing the tag rather than silently skipped.
 *
 * An empty result means the layout this guard assumes no longer holds (renamed
 * or moved packages/), which would make the check pass vacuously — so that is a
 * failure, not a green line.
 */
function getPublishablePackages(): PublishablePackage[] {
	if (!existsSync(PACKAGES_DIR)) {
		throw new GuardError(
			`No packages/ directory at ${PACKAGES_DIR}, so publishable packages cannot be enumerated.`,
		);
	}

	const packages: PublishablePackage[] = [];
	for (const entry of readdirSync(PACKAGES_DIR).sort()) {
		const pkgDir = join(PACKAGES_DIR, entry);
		if (!statSync(pkgDir).isDirectory()) continue;

		const pkgJsonPath = join(pkgDir, "package.json");
		if (!existsSync(pkgJsonPath)) continue;

		const pkgJson = readJson(pkgJsonPath, `packages/${entry}/package.json`);
		if (typeof pkgJson.name !== "string" || !pkgJson.name.startsWith(SCOPE)) continue;
		if (pkgJson.private === true) continue;

		packages.push({
			name: pkgJson.name,
			dir: `packages/${entry}`,
			keywords: Array.isArray(pkgJson.keywords)
				? pkgJson.keywords.filter((k): k is string => typeof k === "string")
				: [],
		});
	}

	if (packages.length === 0) {
		throw new GuardError(
			`Found no publishable ${SCOPE}* packages under ${PACKAGES_DIR}. The guard asserts against\n` +
			"that set, so an empty one means the layout changed and the check would pass vacuously.",
		);
	}
	return packages;
}

function verifyDiscoveryTag(): number {
	const packages = getPublishablePackages();
	const missing = packages.filter((pkg) => !pkg.keywords.includes(DISCOVERY_KEYWORD));

	if (missing.length > 0) {
		console.error(
			`\n❌ The following published package(s) are missing the "${DISCOVERY_KEYWORD}" keyword:\n`,
		);
		for (const pkg of missing) {
			console.error(`   • ${pkg.name}  (${pkg.dir}/package.json)`);
		}
		console.error(
			`\nAdd "${DISCOVERY_KEYWORD}" to each package.json "keywords" array, alongside the\n` +
			"functional keywords describing what the package does. Without it the package never\n" +
			`appears in \`npm search keywords:${DISCOVERY_KEYWORD}\`, the discovery path the\n` +
			"publishing guide documents (#491).\n",
		);
		return 1;
	}

	console.log(
		`✓ All ${packages.length} published package(s) carry the "${DISCOVERY_KEYWORD}" keyword.`,
	);
	return 0;
}

function main(): number {
	const command = process.argv[2];

	switch (command) {
		case "verify-discovery-tag":
			return verifyDiscoveryTag();
		default:
			console.error(
				`Unknown command: ${command ?? "(none)"}\n` +
				"Usage: node --experimental-strip-types scripts/keywords-guard.ts " +
				"<verify-discovery-tag>",
			);
			return 2;
	}
}

try {
	process.exit(main());
} catch (err) {
	if (!(err instanceof GuardError)) throw err;
	console.error(`\n❌ ${err.message}\n`);
	process.exit(1);
}
