// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readdir, readFile, unlink, writeFile, mkdir, stat, access, mkdtemp } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, } from "node:path";
import { execSync } from "node:child_process";
import { LocalPublisher } from "./publishers/local.ts";
import type { PackageInfo, PackResult, Publisher } from "./publishers/types.ts";
import { generateRegistryMetadata, parseExistingMetadata } from "./registry.ts";

const SCOPE = "@aws-blocks/";
const REGISTRY_PREFIX = "registry/";
const ROOT = resolve(import.meta.dirname, "../..");
const PACKAGES_DIR = join(ROOT, "packages");

// ── Package discovery ──────────────────────────────────────────────

async function discoverPackages(): Promise<PackageInfo[]> {
	const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
	const packages: PackageInfo[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const pkgJsonPath = join(PACKAGES_DIR, entry.name, "package.json");
		try {
			const raw = await readFile(pkgJsonPath, "utf-8");
			const pkgJson = JSON.parse(raw);
			if (typeof pkgJson.name === "string" && pkgJson.name.startsWith(SCOPE)) {
				packages.push({
					name: pkgJson.name,
					version: pkgJson.version,
					packageJsonPath: pkgJsonPath,
					packageJson: pkgJson,
					dirPath: join(PACKAGES_DIR, entry.name),
				});
			}
		} catch {
			// skip directories without a valid package.json
		}
	}

	return packages;
}

// ── Template package.json discovery ────────────────────────────────

/**
 * Find all template package.json files inside create-blocks-app/templates/.
 * These contain @aws-blocks/* dependency versions that must be pinned
 * during canary publishes so scaffolded apps resolve the canary version.
 */
async function discoverTemplatePackageJsons(): Promise<string[]> {
	const templatesDir = join(PACKAGES_DIR, "create-blocks-app", "templates");
	const paths: string[] = [];
	try {
		const entries = await readdir(templatesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const pkgJsonPath = join(templatesDir, entry.name, "package.json");
			try {
				await access(pkgJsonPath);
				paths.push(pkgJsonPath);
			} catch {
				// template directory without a package.json — skip
			}
		}
	} catch {
		// create-blocks-app/templates/ doesn't exist — nothing to rewrite
	}
	return paths;
}

// ── Topological sort ───────────────────────────────────────────────

function topoSort(packages: PackageInfo[]): PackageInfo[] {
	const byName = new Map(packages.map((p) => [p.name, p]));
	const visited = new Set<string>();
	const sorted: PackageInfo[] = [];

	function visit(pkg: PackageInfo) {
		if (visited.has(pkg.name)) return;
		visited.add(pkg.name);

		for (const depName of Object.keys(pkg.packageJson.dependencies ?? {})) {
			const dep = byName.get(depName);
			if (dep) visit(dep);
		}

		sorted.push(pkg);
	}

	for (const pkg of packages) visit(pkg);
	return sorted;
}

// ── Pack + hash ────────────────────────────────────────────────────

async function packPackage(pkg: PackageInfo): Promise<PackResult> {
	// npm >= 10 forwards lifecycle-script (prepack) stdout into `npm pack`'s stdout,
	// so the filename is discovered from the filesystem instead of stdout.
	const packDir = await mkdtemp(join(tmpdir(), "aws-blocks-pack-"));

	execSync(`npm pack --pack-destination ${JSON.stringify(packDir)}`, {
		cwd: pkg.dirPath,
		encoding: "utf-8",
	});

	const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
	if (tarballs.length !== 1) {
		throw new Error(
			`expected exactly one .tgz in ${packDir} for ${pkg.name}, found ${tarballs.length}: ${tarballs.join(", ")}`,
		);
	}

	const tarballPath = join(packDir, tarballs[0]!);

	// Validate tarball path stays within the pack destination directory
	const resolvedTarball = resolve(tarballPath);
	if (!resolvedTarball.startsWith(resolve(packDir))) {
		throw new Error(`Tarball path escapes pack destination directory: ${resolvedTarball}`);
	}

	const tarballBuf = await readFile(tarballPath);

	// SHA-512 in SRI format
	const sha512 = createHash("sha512").update(tarballBuf).digest("base64");
	const integrity = `sha512-${sha512}`;

	// SHA-1 hex
	const shasum = createHash("sha1").update(tarballBuf).digest("hex");

	// S3 key: registry/@aws-blocks/core/-/core-0.1.0.tgz
	const shortName = pkg.name.replace(SCOPE, "");
	const tarballS3Key = `${REGISTRY_PREFIX}${pkg.name}/-/${shortName}-${pkg.version}.tgz`;

	return {
		packageName: pkg.name,
		version: pkg.version,
		tarballPath,
		tarballS3Key,
		integrity,
		shasum,
		packageJson: pkg.packageJson,
	};
}

// ── Cleanup ────────────────────────────────────────────────────────

async function cleanupTarballs(results: PackResult[]): Promise<void> {
	await Promise.allSettled(results.map((r) => unlink(r.tarballPath)));
}

// ── Branch name sanitization ───────────────────────────────────────

/**
 * Sanitize a git branch name for use in npm dist-tags and semver pre-release identifiers.
 * - Lowercase
 * - Replace any char not in [a-z0-9-] with -
 * - Collapse consecutive dashes
 * - Trim leading/trailing dashes
 * - Truncate to 50 chars
 */
function sanitizeBranchName(branch: string): string {
	const sanitized = branch
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	return sanitized || "branch";
}

// ── CLI arg parsing ────────────────────────────────────────────────

interface ParsedArgs {
	distTag: string;
	canaryVersion: string | null;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	const canaryIdx = args.indexOf("--canary");

	if (canaryIdx !== -1 && args[canaryIdx + 1]) {
		const safeBranch = sanitizeBranchName(args[canaryIdx + 1]);
		const shortSha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
		const timestamp = Math.floor(Date.now() / 1000);
		return {
			distTag: `canary-${safeBranch}`,
			canaryVersion: `0.0.0-canary.${safeBranch}.${shortSha}.${timestamp}`,
		};
	}

	return { distTag: "latest", canaryVersion: null };
}

// ── Publish orchestrator ───────────────────────────────────────────

async function publish(publisher: Publisher, distTag: string, canaryVersion: string | null) {
	console.log("Discovering packages...");
	const packages = await discoverPackages();
	console.log(`Found ${packages.length} publishable packages: ${packages.map((p) => p.name).join(", ")}`);

	const sorted = topoSort(packages);
	console.log(`Topological order: ${sorted.map((p) => p.name).join(" → ")}`);

	// Override versions for canary publishes
	if (canaryVersion) {
		const packageNames = new Set(sorted.map((p) => p.name));
		console.log(`\nCanary mode: overriding all versions to ${canaryVersion}`);

		for (const pkg of sorted) {
			pkg.version = canaryVersion;
			pkg.packageJson.version = canaryVersion;

			// Rewrite internal dependencies to point to the exact canary version
			const depMaps = [pkg.packageJson.dependencies, pkg.packageJson.peerDependencies].filter(
				(d): d is Record<string, string> => !!d,
			);
			for (const deps of depMaps) {
				for (const depName of Object.keys(deps)) {
					if (packageNames.has(depName)) {
						deps[depName] = canaryVersion;
					}
				}
			}
		}
	}

	// Verify build output exists (don't rebuild — pack what was already built and tested)
	let hasBuildOutput = false;
	for (const pkg of sorted) {
		try {
			await stat(join(pkg.dirPath, "dist"));
			hasBuildOutput = true;
			break;
		} catch {
			// dist/ doesn't exist for this package
		}
	}
	if (!hasBuildOutput) {
		console.error("\n❌ No build output found. Run 'npm run build' first.\n");
		process.exit(1);
	}

	// Write canary versions to disk so npm pack picks them up
	const originalPackageJsons = new Map<string, string>();
	if (canaryVersion) {
		for (const pkg of sorted) {
			const original = await readFile(pkg.packageJsonPath, "utf-8");
			originalPackageJsons.set(pkg.packageJsonPath, original);
			await writeFile(pkg.packageJsonPath, JSON.stringify(pkg.packageJson, null, 2) + "\n");
		}

		// Also rewrite template package.json files so scaffolded apps
		// resolve the canary version instead of "*" or "latest"
		const templatePkgPaths = await discoverTemplatePackageJsons();
		const packageNames = new Set(sorted.map((p) => p.name));
		for (const tplPath of templatePkgPaths) {
			const original = await readFile(tplPath, "utf-8");
			const tplPkg = JSON.parse(original);
			let changed = false;

			for (const depField of ["dependencies", "devDependencies", "peerDependencies"] as const) {
				const deps = tplPkg[depField];
				if (!deps) continue;
				for (const depName of Object.keys(deps)) {
					if (packageNames.has(depName)) {
						deps[depName] = canaryVersion;
						changed = true;
					}
				}
			}

			if (changed) {
				originalPackageJsons.set(tplPath, original);
				await writeFile(tplPath, JSON.stringify(tplPkg, null, 2) + "\n");
				console.log(`  Pinned template deps → ${canaryVersion} in ${relative(ROOT, tplPath)}`);
			}
		}
	}

	// Pack each package
	console.log("\nPacking packages...");
	const results: PackResult[] = [];
	try {
		for (const pkg of sorted) {
			console.log(`  Packing ${pkg.name}@${pkg.version}...`);
			const result = await packPackage(pkg);
			console.log(`    → ${result.tarballS3Key}`);
			console.log(`    → integrity: ${result.integrity.slice(0, 20)}...`);
			results.push(result);
		}
	} finally {
		// Restore original package.json files so we don't dirty the working tree
		for (const [path, content] of originalPackageJsons) {
			await writeFile(path, content);
		}
	}

	// Upload tarballs (atomic strategy)
	// ── Version-exists guard ───────────────────────────────────
	// Check metadata for each package. If the version already exists:
	//   - Compare the integrity hash in metadata against the newly packed tarball
	//   - Identical hash → skip (package wasn't bumped, harmless re-pack)
	//   - Different hash → fail (someone changed code without a version bump)
	// This is checked before any uploads — no partial publish on failure.
	console.log("\nChecking for existing versions...");
	const toUpload: PackResult[] = [];
	for (const r of results) {
		const metadataKey = `${REGISTRY_PREFIX}${r.packageName}/index.json`;
		const existingBuf = await publisher.fetchExisting(metadataKey);
		if (existingBuf) {
			const existing = parseExistingMetadata(existingBuf);
			const existingVersion = existing?.versions[r.version] as Record<string, unknown> | undefined;
			if (existingVersion) {
				const existingDist = existingVersion.dist as { integrity?: string } | undefined;
				if (existingDist?.integrity === r.integrity) {
					console.log(`  ${r.packageName}@${r.version} — unchanged, skipping`);
					continue;
				} else {
					throw new Error(
						`${r.packageName}@${r.version} already exists with different content. ` +
						`Did you forget to include it in your changeset?`,
					);
				}
			}
		}
		console.log(`  ${r.packageName}@${r.version} — new version, will upload`);
		toUpload.push(r);
	}

	if (toUpload.length === 0) {
		console.log("\nAll versions already exist in registry. Nothing to publish.");
		await cleanupTarballs(results);
		return {
			publishedAt: new Date().toISOString(),
			distTag,
			packages: results.map((r) => ({
				name: r.packageName,
				version: r.version,
				tarballS3Key: r.tarballS3Key,
				integrity: r.integrity,
				shasum: r.shasum,
			})),
		};
	}

	console.log(`\nUploading ${toUpload.length} tarball(s)...`);
	const tarballFiles = await Promise.all(
		toUpload.map(async (r) => ({
			key: r.tarballS3Key,
			body: await readFile(r.tarballPath),
			contentType: "application/gzip",
		})),
	);
	await publisher.upload(tarballFiles);

	// Clean up local .tgz files left by npm pack
	await cleanupTarballs(results);

	// Generate and upload metadata
	console.log("Generating registry metadata...");
	const baseUrl = publisher.getBaseUrl();
	const metadataFiles = [];

	for (const result of toUpload) {
		const metadataKey = `${REGISTRY_PREFIX}${result.packageName}/index.json`;
		const existingBuf = await publisher.fetchExisting(metadataKey);
		const existing = existingBuf ? parseExistingMetadata(existingBuf) : null;

		const metadata = generateRegistryMetadata(result, baseUrl, existing, distTag);
		const body = Buffer.from(JSON.stringify(metadata, null, 2));

		metadataFiles.push({ key: metadataKey, body, contentType: "application/json" });
		console.log(`  ${metadataKey} (${Object.keys(metadata.versions).length} version(s))`);
	}

	await publisher.upload(metadataFiles);

	// Cache invalidation
	const invalidationPaths = metadataFiles.map((f) => `/${f.key}`);
	await publisher.invalidateCache(invalidationPaths);

	// Summary
	console.log("\n✓ Published successfully:");
	for (const r of toUpload) {
		console.log(`  ${r.packageName}@${r.version}`);
	}

	// Write manifest
	const manifest = {
		publishedAt: new Date().toISOString(),
		distTag,
		packages: toUpload.map((r) => ({
			name: r.packageName,
			version: r.version,
			tarballS3Key: r.tarballS3Key,
			integrity: r.integrity,
			shasum: r.shasum,
		})),
		skipped: results
			.filter((r) => !toUpload.includes(r))
			.map((r) => ({ name: r.packageName, version: r.version })),
	};

	return manifest;
}

// ── CLI entry point ────────────────────────────────────────────────

const { distTag, canaryVersion } = parseArgs();

const bucket = process.env.S3_BUCKET;
const cfDomain = process.env.CLOUDFRONT_DOMAIN;
const cfDistId = process.env.CLOUDFRONT_DISTRIBUTION_ID;

let publisher: Publisher;
let mode: string;

if (bucket && cfDomain && cfDistId) {
	const { S3Publisher } = await import("./publishers/s3.ts");
	publisher = new S3Publisher(bucket, cfDomain, cfDistId);
	mode = "s3";
} else {
	publisher = new LocalPublisher(join(ROOT, "dist-registry"));
	mode = "local";
}

console.log(`AWS Blocks Publish — ${mode === "s3" ? "S3" : "dry-run (local)"} (dist-tag: ${distTag})\n`);

const manifest = await publish(publisher, distTag, canaryVersion);

// Write manifest
const manifestDir = mode === "s3" ? ROOT : join(ROOT, "dist-registry");
await mkdir(manifestDir, { recursive: true });
const manifestPath = join(manifestDir, "publish-manifest.json");
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`\nManifest written to ${manifestPath}`);
