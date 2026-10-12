// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Cross-platform template E2E driver — runs on BOTH Linux and Windows PR lanes.
//
// Publishes all packages to a local file-based registry, then for every
// scaffoldable template: creates an app from the published CLI (exactly as a
// customer would), runs its `test:e2e` suite, and runs `vendorize`. The suite
// is LOCAL ONLY — each template's `test:e2e` boots a mock dev server, so there
// is no AWS deploy and no credentials are needed. The real deploy/sandbox smoke
// stays in windows-e2e.yml (scheduled).
//
// This is the single harness for the per-PR template suite (it replaced a
// bash-only script that could not run on Windows), so the same check runs
// identically on every OS — the OS fork is confined to spawn/kill/path
// mechanics here, instead of two separate harnesses that drift apart.
//
// Usage:  node scripts/ci/templates-e2e.mjs [--skip-publish]
//   --skip-publish   reuse an existing dist-registry (CI packs it in an
//                    earlier job and downloads it as an artifact).

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree, runBool, startRegistry, isWin } from './_proc.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const REGISTRY_PORT = 4873;
const REGISTRY_URL = `http://localhost:${REGISTRY_PORT}/registry/`;
const TEMPLATES_DIR = join(ROOT, 'packages', 'create-blocks-app', 'templates');
const skipPublish = process.argv.includes('--skip-publish');

const children = [];
// The scratch work dir, created in main(). Module-scoped so shutdown() can
// remove it on every exit path (success, failure, or SIGINT/SIGTERM), the way
// the removed bash harness did with `trap cleanup EXIT`.
let work;

/** Reap spawned children and remove the scratch dir. Safe to call more than once. */
function shutdown() {
	for (const c of children) killTree(c.pid);
	if (work) {
		rmSync(work, { recursive: true, force: true });
		work = undefined;
	}
}

// An interrupted local run (Ctrl-C during `npm run test:templates`) must still
// tear down the detached registry child and the scratch dir; CI kills the whole
// job, but the package.json script now exposes this driver to local devs.
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		shutdown();
		process.exit(1);
	});
}

/** Run a one-shot command; return true on exit 0, false otherwise (never throws). */
const run = (cmd, args, opts = {}) => runBool(cmd, args, opts, ROOT);

/**
 * The scaffoldable template set, derived from templates/ so it can never drift
 * from what the CLI actually scaffolds. A fresh-project template is one whose
 * package.json declares a `test:e2e` script; that excludes `amplify` (an
 * integration into an existing Amplify Gen 2 project, covered by
 * e2e-amplify-interop.yml) and any future overlay template.
 */
function discoverTemplates() {
	const names = [];
	for (const name of readdirSync(TEMPLATES_DIR)) {
		const pkgPath = join(TEMPLATES_DIR, name, 'package.json');
		if (!existsSync(pkgPath)) continue;
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
			if (pkg.scripts?.['test:e2e']) names.push(name);
		} catch {
			/* not a template dir */
		}
	}
	return names.sort();
}

async function main() {
	// ── Step 1: publish to the local registry (unless reusing dist-registry) ──
	if (skipPublish && existsSync(join(ROOT, 'dist-registry'))) {
		console.log('=== Step 1: Skipping publish (using existing dist-registry) ===');
	} else {
		console.log('=== Step 1: Publish to local registry ===');
		// Route through the npm script so `publish:local` stays the single
		// definition of how we publish locally (and the error message matches).
		if (!run('npm', ['run', 'publish:local'], { cwd: ROOT })) {
			throw new Error('publish:local failed');
		}
	}

	// ── Step 2: start the local registry (node + tsx loader, no shim needed) ──
	console.log('\n=== Step 2: Start local registry ===');
	await startRegistry({ root: ROOT, registryUrl: REGISTRY_URL, children });
	console.log('  Registry ready.');

	// ── Step 3: isolate npm (temp user config + cache; scoped registry) ───────
	// RUNNER_TEMP is a long path; os.tmpdir() on Windows runners is the 8.3 short
	// path (C:\Users\RUNNER~1\...), which breaks some tooling.
	const baseTmp = process.env.RUNNER_TEMP || tmpdir();
	work = mkdtempSync(join(baseTmp, 'bb-templates-e2e-'));
	const userNpmrc = join(work, '.npmrc');
	writeFileSync(userNpmrc, `@aws-blocks:registry=${REGISTRY_URL}\n`);
	const env = {
		...process.env,
		NPM_CONFIG_USERCONFIG: userNpmrc,
		npm_config_cache: join(work, '.npm-cache'),
	};

	console.log('\n=== Step 3: Install create-blocks-app from registry ===');
	if (!run('npm', ['install', '@aws-blocks/create-blocks-app@latest'], { cwd: work, env })) {
		throw new Error('installing @aws-blocks/create-blocks-app from the local registry failed');
	}
	const createBin = join(work, 'node_modules', '.bin', isWin ? 'create-blocks-app.cmd' : 'create-blocks-app');

	// ── Step 4: per-template loop (scaffold → test:e2e → vendorize) ───────────
	const templates = discoverTemplates();
	if (templates.length === 0) throw new Error(`no scaffoldable templates found under ${TEMPLATES_DIR}`);
	console.log(`\nTemplates under e2e: ${templates.join(' ')}`);

	const failed = [];
	for (const template of templates) {
		console.log(`\n============================================`);
		console.log(`=== Testing template: ${template}`);
		console.log(`============================================`);

		const appParent = join(work, `app-${template}`);
		mkdirSync(appParent, { recursive: true });
		const app = join(appParent, 'my-app');
		const inApp = { cwd: app, env };

		// `default` is the implicit template (no --template flag); others are named.
		const createArgs = template === 'default' ? [app] : [app, '--template', template];
		console.log('\n--- Creating app from registry ---');
		if (!run(createBin, createArgs, { cwd: appParent, env })) {
			console.error(`  FAIL: create-blocks-app failed for template ${template}`);
			failed.push(template);
			continue;
		}

		console.log('\n--- Running e2e tests ---');
		if (!run('npm', ['run', 'test:e2e'], inApp)) {
			console.error(`  FAIL: e2e tests failed for template ${template}`);
			failed.push(template);
			continue;
		}

		console.log('\n--- Testing vendorize bin ---');
		if (!run('npm', ['run', 'vendorize', '--', '@aws-blocks/bb-kv-store'], inApp)) {
			console.error(`  FAIL: vendorize failed for template ${template}`);
			failed.push(template);
			continue;
		}
		// The vendorized source must land (either the single-file or split layout).
		const vendoredTs = join(app, 'vendor', 'bb-kv-store', 'src', 'index.ts');
		const vendoredCdk = join(app, 'vendor', 'bb-kv-store', 'src', 'index.cdk.ts');
		if (!existsSync(vendoredTs) && !existsSync(vendoredCdk)) {
			console.error(`  FAIL: vendorized source not found for template ${template}`);
			failed.push(template);
			continue;
		}
		console.log(`  ✓ Template ${template} passed all checks`);
	}

	console.log(`\n============================================`);
	if (failed.length === 0) {
		console.log(`✅ All template e2e tests passed on ${process.platform}!`);
	} else {
		throw new Error(`template e2e failed on ${process.platform}: ${failed.join(', ')}`);
	}
}

main()
	.then(() => {
		shutdown();
		process.exit(0);
	})
	.catch((err) => {
		console.error(`\nFAIL: ${err?.message ?? err}`);
		shutdown();
		process.exit(1);
	});
