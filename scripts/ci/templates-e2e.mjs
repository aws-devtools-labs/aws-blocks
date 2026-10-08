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

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const isWin = process.platform === 'win32';
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

/** Kill a process tree cross-platform (Windows has no POSIX process groups). */
function killTree(pid) {
	if (!pid) return;
	try {
		if (isWin) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
		else process.kill(-pid, 'SIGKILL');
	} catch {
		/* already gone */
	}
}

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
function run(cmd, args, opts = {}) {
	console.log(`\n$ ${cmd} ${args.join(' ')}  (cwd: ${opts.cwd ?? ROOT})`);
	// shell:true on Windows so `.cmd` shims (npm, create-blocks-app) resolve.
	// NOTE: with shell:true spawnSync does NOT auto-quote args, so a path arg
	// containing a space would break the Windows command line. Safe here because
	// the only path args (createBin, app) derive from RUNNER_TEMP, which on
	// GitHub windows-latest has no spaces. If this is ever run on a Windows host
	// whose temp dir contains a space, quote those args or drop shell:true.
	const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, ...opts });
	return r.status === 0;
}

async function httpUp(url) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
		// Match the old `curl -sf`: only a 2xx (metadata actually served) is
		// ready. A 404 while the package metadata is not yet readable is NOT.
		return res.ok;
	} catch {
		return false;
	}
}

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
	const registry = spawn(process.execPath, ['--import', 'tsx', 'scripts/publish/serve-local-registry.ts'], {
		cwd: ROOT,
		stdio: 'inherit',
		detached: !isWin,
	});
	children.push(registry);
	for (let i = 0; ; i++) {
		if (await httpUp(`${REGISTRY_URL}@aws-blocks/blocks`)) break;
		// Fail fast if the server already died (e.g. :4873 bound, or a malformed
		// dist-registry) so its real cause surfaces instead of a ~31s timeout.
		if (registry.exitCode !== null) {
			throw new Error(`Local registry process exited (${registry.exitCode}) before becoming ready on :${REGISTRY_PORT}`);
		}
		if (i > 30) throw new Error(`Local registry did not start on :${REGISTRY_PORT}`);
		await sleep(1000);
	}
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
