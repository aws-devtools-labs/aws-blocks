// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Blocks canary.
 *
 * Scaffolds a fresh app from a published @aws-blocks registry.
 *
 * Usage:
 *   tsx scripts/canary/run-canary.ts [--template <name>] [--registry <url>] [--keep]
 *
 * Environment:
 *   BLOCKS_REGISTRY_URL    Scoped registry for @aws-blocks (overridden by --registry).
 *   BLOCKS_REGISTRY_TOKEN  Auth token for the registry (omit for an open registry).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  execFileSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
}

/** Run a command and capture trimmed stdout. */
function capture(
  cmd: string,
  cmdArgs: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): string {
  return execFileSync(cmd, cmdArgs, { encoding: "utf-8", ...opts }).trim();
}

// ── Main ────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs();
  const workDir = mkdtempSync(join(tmpdir(), "blocks-canary-"));

  console.log("=== Blocks canary ===");
  console.log(`  template : ${args.template}`);
  console.log(`  work dir : ${workDir}`);

  // Isolate npm config + cache so we never touch the developer's ~/.npmrc
  // and never serve a stale tarball out of the shared cache.
  const npmrcPath = join(workDir, ".npmrc");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: npmrcPath,
    npm_config_cache: join(workDir, ".npm-cache"),
    // The template e2e uses node:test; keep the runner output clean.
    NODE_OPTIONS: "--test-reporter=spec",
  };

  const npmrcLines = [`@aws-blocks:registry=${args.registry}`];
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
      ["view", "@aws-blocks/create-blocks-app", "version"],
      { cwd: workDir, env },
    );
    console.log(`  @aws-blocks/create-blocks-app@${cliVersion}`);

    // ── Install the CLI from the published registry ─────────
    console.log("\n=== Install create-blocks-app from published registry ===");
    run("npm", ["install", "@aws-blocks/create-blocks-app@latest", "--silent"], {
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

    // ── Build ───────────────────────────────────────────────
    console.log("\n=== Build scaffolded app ===");
    run("npm", ["run", "build"], { cwd: appDir, env });

    // ── Local e2e (mocks) ───────────────────────────────────
    console.log("\n=== Run local e2e (mocks, no AWS account) ===");
    run("npm", ["run", "test:e2e"], { cwd: appDir, env });

    console.log(
      `\n🎉 Blocks canary passed (template: ${args.template}).`,
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
