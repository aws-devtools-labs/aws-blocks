// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK Blocks canary.
 *
 * Scaffolds a fresh app from a published @aws-cdk-blocks registry, then builds it,
 * runs its local e2e (mocks) and runs `cdk synth` (no AWS credentials).
 *
 * Usage:
 *   tsx scripts/canary/run-canary.ts [--template <name>] [--registry <url>] [--keep]
 *
 * Environment:
 *   BLOCKS_REGISTRY_URL    Default registry the scaffolded app installs from (overridden by --registry).
 *   BLOCKS_REGISTRY_TOKEN  Auth token for the registry (omit for an open registry).
 *
 * The registry is set as npm's DEFAULT, not per scope: npm resolves a registry
 * per scope, so a `@aws-cdk-blocks:registry=` line cannot route the unscoped
 * `aws-cdk-blocks` umbrella. So whatever `--registry` points at has to answer
 * for EVERY package the scaffolded app installs, third-party ones included.
 * `scripts/publish/serve-local-registry.ts` forwards those upstream and is the
 * supported target; a registry serving only this repo's keys (the S3/CloudFront
 * one `publish.ts` uploads to) would 404 `zod`, `aws-cdk-lib` and the rest, so
 * it needs the local proxy in front of it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── CLI args ────────────────────────────────────────────────────────

interface Args {
  template: string;
  registry: string;
  keep: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    template: "default",
    registry: process.env.BLOCKS_REGISTRY_URL || "",
    keep: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--template":
        args.template = required(argv[++i], "--template");
        break;
      case "--registry":
        args.registry = required(argv[++i], "--registry");
        break;
      case "--keep":
        args.keep = true;
        break;
      default:
        fail(`Unknown argument: ${a}`);
    }
  }

  if (!args.registry) {
    fail(
      "registry URL not set. Pass --registry <url> or set BLOCKS_REGISTRY_URL.",
    );
  }

  // Normalise to a trailing slash so npm's token host-key matches.
  if (!args.registry.endsWith("/")) args.registry += "/";

  return args;
}

function required(v: string | undefined, flag: string): string {
  if (!v) fail(`${flag} requires a value`);
  return v;
}

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(2);
}

// ── Shell helpers ───────────────────────────────────────────────────

/** Run a command, inheriting stdio, with the canary's isolated npm env. */
function run(
  cmd: string,
  cmdArgs: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): void {
  console.log(`\n$ ${cmd} ${cmdArgs.join(" ")}`);
  execFileSync(cmd, cmdArgs, { stdio: "inherit", cwd: opts.cwd, env: opts.env });
}

/** Run a command and capture trimmed stdout. */
function capture(
  cmd: string,
  cmdArgs: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): string {
  return execFileSync(cmd, cmdArgs, {
    encoding: "utf-8",
    cwd: opts.cwd,
    env: opts.env,
  }).trim();
}

/** Every install path of `name` in the app's package-lock.json. */
function installedPaths(appDir: string, name: string): string[] {
  const lock = JSON.parse(readFileSync(join(appDir, "package-lock.json"), "utf-8")) as {
    packages?: Record<string, unknown>;
  };
  return Object.keys(lock.packages ?? {}).filter((path) => path.endsWith(`node_modules/${name}`));
}

// ── Main ────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs();
  const workDir = mkdtempSync(join(tmpdir(), "blocks-canary-"));

  console.log("=== AWS CDK Blocks canary ===");
  console.log(`  template : ${args.template}`);
  console.log(`  work dir : ${workDir}`);

  // Isolate npm config + cache so we never touch the developer's ~/.npmrc
  // and never serve a stale tarball out of the shared cache.
  const npmrcPath = join(workDir, ".npmrc");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // `npm run canary` exports a lowercase npm_config_userconfig (~/.npmrc).
    // npm reads both spellings and the one later in the environment wins, and
    // the scaffold's own `npm install` inherits a reordered environment, so set
    // both: otherwise the app installs from the public registry.
    NPM_CONFIG_USERCONFIG: npmrcPath,
    npm_config_userconfig: npmrcPath,
    npm_config_cache: join(workDir, ".npm-cache"),
    // The template e2e uses node:test; keep the runner output clean.
    NODE_OPTIONS: "--test-reporter=spec",
  };

  // The default registry, not a scope line: npm resolves a registry per scope,
  // so `@aws-cdk-blocks:registry=` cannot route the unscoped `aws-cdk-blocks`
  // umbrella the templates depend on.
  const npmrcLines = [`registry=${args.registry}`];
  if (process.env.BLOCKS_REGISTRY_TOKEN) {
    // npm keys the token on //host/path/ (scheme stripped).
    const hostPath = args.registry.replace(/^https?:/, "");
    npmrcLines.push(
      `${hostPath}:_authToken=${process.env.BLOCKS_REGISTRY_TOKEN}`,
    );
  }
  writeFileSync(npmrcPath, `${npmrcLines.join("\n")}\n`);

  const appDir = join(workDir, "canary-app");

  try {
    // ── Verify registry access ──────────────────────────────
    console.log("\n=== Verify registry access ===");
    const cliVersion = capture(
      "npm",
      ["view", "@aws-cdk-blocks/create-blocks-app", "version"],
      { cwd: workDir, env },
    );
    console.log(`  @aws-cdk-blocks/create-blocks-app@${cliVersion}`);

    // ── Install the CLI from the published registry ─────────
    console.log("\n=== Install create-blocks-app from published registry ===");
    run("npm", ["install", "@aws-cdk-blocks/create-blocks-app@latest", "--silent"], {
      cwd: workDir,
      env,
    });
    const createCmd = join(
      workDir,
      "node_modules",
      ".bin",
      "create-blocks-app",
    );

    // ── Scaffold ────────────────────────────────────────────
    console.log(`\n=== Scaffold app (template: ${args.template}) ===`);
    const scaffoldArgs = [appDir];
    if (args.template !== "default") {
      scaffoldArgs.push("--template", args.template);
    }
    run(createCmd, scaffoldArgs, { cwd: workDir, env });

    // ── One copy of @aws-cdk-blocks/core ────────────────────────
    // core keeps module-level registries (SDK identifiers, the branded-error
    // class), so a second copy splits them: getSdkIdentifiers() returns {} and
    // `instanceof ApiError` fails. npm nests core under every block when a
    // scaffold's devDependency conflicts with core's optional-peer chain
    // (unctx → unplugin → vitest pins @types/node), so check the installed tree.
    console.log("\n=== Verify a single @aws-cdk-blocks/core install ===");
    const corePaths = installedPaths(appDir, "@aws-cdk-blocks/core");
    if (corePaths.length !== 1) {
      throw new Error(
        `expected one @aws-cdk-blocks/core in node_modules, found ${corePaths.length}:\n  ${corePaths.join("\n  ")}`,
      );
    }
    console.log(`  ${corePaths[0]}`);

    // ── Build ───────────────────────────────────────────────
    console.log("\n=== Build scaffolded app ===");
    run("npm", ["run", "build"], { cwd: appDir, env });

    // ── Local e2e (mocks) ───────────────────────────────────
    console.log("\n=== Run local e2e (mocks, no AWS account) ===");
    run("npm", ["run", "test:e2e"], { cwd: appDir, env });

    // ── CDK synth (no AWS account) ──────────────────────────
    // The e2e above runs on mocks, so it never loads the CDK entry points.
    // Synth does: it resolves the scaffold's fresh `^` aws-cdk-lib range and
    // builds every block's construct, catching a CDK-layer break (a new CDK
    // release, a construct that needs an account lookup) the day it lands
    // rather than on a customer's first deploy. The runner has no AWS
    // credentials, so this also proves a template synthesizes without them.
    // Warnings (unset feature flags, alarm topic without subscribers) are
    // expected; only a non-zero exit fails the canary.
    if (existsSync(join(appDir, "cdk.json"))) {
      console.log("\n=== CDK synth (no AWS credentials) ===");
      run("npx", ["--no", "cdk", "synth", "-q"], { cwd: appDir, env });
    } else {
      console.log("\n=== CDK synth skipped: template has no cdk.json ===");
    }

    console.log(
      `\n🎉 CDK Blocks canary passed (template: ${args.template}).`,
    );
  } finally {
    if (args.keep) {
      console.log(`\n=== Keeping work dir: ${workDir} ===`);
    } else {
      console.log("\n=== Cleanup ===");
      // A process the e2e stopped can still be exiting; retry rather than fail a passing run on ENOTEMPTY.
      rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      console.log(`  Removed ${workDir}`);
    }
  }
}

main();
