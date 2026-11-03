// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { ensureSecrets, loadEnvFile } from './ensure-secrets.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { applyExternalMigrations } from './external-migrations-step.js';
import { trackCommand } from '../telemetry/trackCommand.js';
import { buildAndSendEvent } from '../telemetry/client.js';
import { classifyError } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv, getFrameworkSinkEnv } from './cdk-telemetry-env.js';
import { createFrameworkSink, registerFrameworkFromSink } from '../telemetry/framework-sink.js';
import { formatDeploySignal } from './deploy-stream.js';
import { spawnCommand } from './run-command.js';
import { terminateProcessTree } from './process-tree.js';
import { generateDeployClient } from './deploy-client-codegen.js';
import { attachCdkWatchOutput, createCdkOutput } from './cdk-output.js';
import { log } from './log.js';
import {
  destroyRetryClients,
  findExpressUnsafeStacks,
  runDestroyWithRetries,
  SANDBOX_DESTROY_ASSEMBLY_DIR,
  sandboxDestroyDeps,
  stacksWithExpressUnsafeResources,
} from './sandbox-destroy.js';

export interface SandboxOptions {
  backendPath: string;
  outDir?: string;
  clientPort?: number;
  deployOnly?: boolean;
  /** Custom dev server command. Defaults to 'npx vite'. For Next.js use 'npx next dev'. */
  devCommand?: string;
  /**
   * Deploy a preview sandbox: a sandbox that includes hosting in preview
   * shape (`npm run sandbox:preview`). Synth and deploy get
   * `--context previewMode=true` (see {@link PREVIEW_MODE_CONTEXT}) next to
   * `sandboxMode=true`; the app reads it to add `Hosting` with
   * `HostingPresets.preview`. A plain sandbox stays backend-only.
   *
   * A preview sandbox is deploy-only (as with {@link SandboxOptions.deployOnly}):
   * it deploys once and exits, with no `cdk watch` and no local dev server.
   * Run it again to re-deploy.
   *
   * Only a preview RE-deploy uses `--hotswap-fallback`: a code-only change is
   * applied straight to the Lambda functions in seconds, falling back to a
   * CloudFormation deploy (direct, no change set) for anything that can't be
   * hotswapped. Hotswap leaves the stack drifted from its template, which is
   * acceptable for a throwaway preview only, so every other sandbox keeps the
   * CloudFormation deploy.
   *
   * A deploy counts as a re-deploy when `<outDir>/outputs.json` exists in the
   * current working directory (the previous deploy wrote it); the stack itself
   * is not queried. So a re-deploy from another directory, or after deleting
   * that file, runs a full deploy (slower, but correct). A stale file left
   * after the stack was deleted makes `--hotswap-fallback` find no stack, and
   * it falls back to a full deploy.
   */
  preview?: boolean;
}

/**
 * How the sandbox spawns the local dev server. It runs under `shell: true`, so
 * the whole command goes to the shell as one string with no separate args:
 * Node 24 emits DEP0190 whenever a non-empty args array is combined with
 * `shell: true`, because the args are only concatenated, never escaped.
 */
export function buildDevServerSpawn(devCommand: string | undefined): { command: string; args: string[] } {
  return { command: devCommand || 'npx tsx watch aws-blocks/scripts/server.ts', args: [] };
}

/**
 * The CDK context key a preview sandbox sets (`--context previewMode=true`),
 * next to `sandboxMode=true`. The app reads it to add `Hosting` in preview
 * shape to the sandbox, which otherwise deploys the backend only:
 *
 * ```ts
 * const previewMode = app.node.tryGetContext('previewMode') === 'true';
 * if (!sandboxMode || previewMode) {
 *   new Hosting(stack, 'Hosting', { ...(previewMode ? HostingPresets.preview : HostingPresets.production), root, api });
 * }
 * ```
 */
export const PREVIEW_MODE_CONTEXT = "previewMode";

/**
 * The site URL from a stack's outputs: the `Hosting` construct's `HostingUrl`
 * output, whose key CDK prefixes with the construct path and suffixes with a
 * hash (e.g. `HostingHostingUrl4F2C…`).
 *
 * @param stackOutputs one stack's outputs from `outputs.json`.
 * @returns the URL with a scheme, or `undefined` when the stack has no hosting.
 */
export function findHostingUrl(stackOutputs: Record<string, string>): string | undefined {
  const key = Object.keys(stackOutputs).find((k) => /HostingUrl/.test(k));
  const url = key ? stackOutputs[key] : undefined;
  if (!url) return undefined;
  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

/**
 * The warning a plain (backend-only) sandbox deploy prints when the stack has
 * a hosted preview. `sandbox`, `sandbox:deploy` and `sandbox:preview` deploy
 * one stack, and only a preview synth includes `Hosting`, so a plain deploy
 * removes the preview; the next `sandbox:preview` recreates it at a new URL.
 *
 * @param outputsFile the previous deploy's `outputs.json`.
 * @param preview whether this deploy is a preview.
 * @returns the warning, or `undefined` for a preview deploy, a stack with no
 *   hosting, or no (or an unreadable) outputs file.
 */
export function previewRemovalWarning(outputsFile: string, preview: boolean): string | undefined {
  if (preview || !existsSync(outputsFile)) return undefined;
  let groups: Record<string, string>[];
  try {
    groups = Object.values(JSON.parse(readFileSync(outputsFile, "utf-8")) ?? {}) as Record<string, string>[];
  } catch {
    return undefined;
  }
  const hostingUrl = groups.map((group) => findHostingUrl(group ?? {})).find(Boolean);
  if (!hostingUrl) return undefined;
  return (
    `⚠️  This stack has a hosted preview at ${hostingUrl}. A plain sandbox deploy is backend-only and removes it.\n` +
    "   Run npm run sandbox:preview to keep it (re-adding it later gives a new URL)."
  );
}

export interface SandboxDeployArgsOptions {
  /** Directory CDK writes stack outputs to (relative to the project root). */
  outDir: string;
  /** Project root passed to synth as `--context projectRoot=…` (usually `process.cwd()`). */
  projectRoot: string;
  /** Backend entry passed to `--app` so CDK synthesizes from the app definition. */
  backendPath: string;
  /**
   * Use CloudFormation Express Mode (`--express`). Default `true`. Turned off
   * when the deployed sandbox contains a resource Express Mode can't update —
   * see {@link findExpressUnsafeStacks}.
   */
  express?: boolean;
  /**
   * Deploy an already-synthesized cloud assembly (`--app <dir>`) instead of
   * synthesizing from `backendPath` again. The sandbox synthesizes once into
   * `<outDir>/cdk.out` to inspect the templates, then deploys that output, so
   * the framework build runs only once.
   */
  assemblyDir?: string;
  /**
   * Add `--hotswap-fallback` (next to `--method direct`, which its fallback
   * CloudFormation deploy uses). `startSandbox` sets it only for a preview
   * re-deploy (see {@link SandboxOptions.preview}).
   */
  hotswap?: boolean;
  /**
   * Synthesize and deploy a preview sandbox: adds `--context previewMode=true`
   * (see {@link PREVIEW_MODE_CONTEXT}). `startSandbox` sets it from
   * {@link SandboxOptions.preview}.
   */
  preview?: boolean;
}

/**
 * Build the `npm exec cdk -- synth …` argv the sandbox runs first: synthesize
 * once into `<outDir>/cdk.out`, inspect the templates (see
 * {@link stacksWithExpressUnsafeResources}), then deploy that assembly.
 */
export function buildSandboxSynthArgs({ outDir, projectRoot, backendPath, preview = false }: SandboxDeployArgsOptions): string[] {
  return [
    "exec", "cdk", "--", "synth",
    "--quiet",
    "--output", `${outDir}/cdk.out`,
    "--context", `projectRoot=${projectRoot}`,
    "--context", "sandboxMode=true",
    ...(preview ? ["--context", `${PREVIEW_MODE_CONTEXT}=true`] : []),
    "--app", `npm exec tsx -- -C cdk ${backendPath}`,
  ];
}

/**
 * cdk child env for the sandbox synth + deploy. Includes the telemetry framework
 * sink so the synth child reports its framework before this parent emits SUCCESS.
 * The watch spawn omits it: watch sends no event, and the sink is already consumed
 * and deleted by then, so wiring this same path in would silently write nowhere.
 */
export function buildSandboxCdkEnv(frameworkSink: string | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_OPTIONS: "--conditions=cdk",
    ...getCdkTelemetryEnv('sandbox'),
    ...getFrameworkSinkEnv(frameworkSink),
  };
}

/**
 * Build the `npx cdk watch …` argv the sandbox runs after its first deploy.
 * Only a plain sandbox watches: a preview sandbox is deploy-only (see
 * {@link sandboxIsDeployOnly}).
 */
export function buildSandboxWatchArgs({ outDir, projectRoot, backendPath }: SandboxDeployArgsOptions): string[] {
  return [
    "cdk", "watch",
    "--outputs-file", `${outDir}/outputs.json`,
    "--context", `projectRoot=${projectRoot}`,
    "--context", "sandboxMode=true",
    "--app", `npm exec tsx -- -C cdk ${backendPath}`,
  ];
}

/**
 * Whether the sandbox stops after its deploy (no `cdk watch`, no local dev
 * server): with `deployOnly`, and always for a preview. A watch would
 * re-deploy the hosted preview, with a full framework build, on every save.
 *
 * @internal
 */
export function sandboxIsDeployOnly({ deployOnly = false, preview = false }: Pick<SandboxOptions, "deployOnly" | "preview">): boolean {
  return deployOnly || preview;
}

/**
 * Build the `npm exec cdk -- deploy …` argv used by the sandbox deploy.
 *
 * Kept pure (no I/O) so the argv contract — in particular the flags below — can
 * be asserted directly, the same way {@link buildCdkDeployArgs} is for the
 * production path.
 *
 * - `--all`: an app that uses Lambda@Edge (e.g. a Next.js route with
 *   `export const runtime = 'edge'`) synthesizes a SECOND stack
 *   (`edge-lambda-stack-*`, region us-east-1) in addition to the main hosting
 *   stack. Without `--all`, CDK refuses with "specify which stacks to use".
 *   Deploying every stack in a sandbox app is the intended behavior.
 * - `--method direct`: skip CloudFormation change-set creation and call
 *   UpdateStack directly. This is the baseline sandbox deployment method that
 *   `--express` builds on.
 * - `--express` (**CloudFormation Express Mode — sandbox only**): the real
 *   speedup. CloudFormation reports each stack operation complete as soon as
 *   the resource's configuration is applied, WITHOUT waiting for full
 *   stabilization. Because it skips stabilization it also disables automatic
 *   rollback by default, so a failed deploy can leave the stack in a failed
 *   state — acceptable for the throwaway sandbox iteration loop, never for
 *   production. We leave rollback at Express Mode's default (off) and do NOT
 *   pass `--rollback`. The production deploy path (`deploy.ts`) deliberately
 *   uses neither `--express` nor `--method direct`: it keeps a reviewable
 *   change set and full stabilization with rollback, which are exactly the
 *   safety signals a production deploy should keep. Requires an aws-cdk CLI
 *   new enough to expose `--express`; our pinned `^2.1138.0` has it.
 *   `express: false` drops it (still `--method direct`, with rollback) for a
 *   sandbox whose deployed stack Express Mode can't update — currently a Lambda
 *   Web Function endpoint (`compute.type: 'web-function'`).
 * - `--hotswap-fallback` (`hotswap`, a preview re-deploy only): next to
 *   `--method direct`, apply a code-only change straight to the Lambda
 *   functions and S3 assets, falling back to a CloudFormation deploy (still
 *   direct and in Express Mode) for a change that can't be hotswapped. The
 *   CDK CLI deploys the fallback with the `--method` given; without one, the
 *   fallback creates and executes a change set, which adds its own wait
 *   (about 13 s on a preview stack). A true hotswap
 *   needs a deterministic template: a tag or name whose value changes per
 *   synth (a date, a git SHA, a per-deploy build id) forces the fallback
 *   every time. Preview mode pins its build id for this reason.
 */
export function buildSandboxDeployArgs({
  outDir,
  projectRoot,
  backendPath,
  express = true,
  assemblyDir,
  hotswap = false,
  preview = false,
}: SandboxDeployArgsOptions): string[] {
  return [
    "exec", "cdk", "--", "deploy",
    "--all",
    ...(hotswap ? ["--hotswap-fallback"] : []),
    "--method", "direct",
    ...(express ? ["--express"] : []),
    "--require-approval", "never",
    "--outputs-file", `${outDir}/outputs.json`,
    "--context", `projectRoot=${projectRoot}`,
    "--context", "sandboxMode=true",
    ...(preview ? ["--context", `${PREVIEW_MODE_CONTEXT}=true`] : []),
    "--app", assemblyDir ?? `npm exec tsx -- -C cdk ${backendPath}`,
  ];
}

/**
 * Operator-facing recovery guidance printed when a sandbox deploy fails.
 *
 * Express Mode (see {@link buildSandboxDeployArgs}) disables CloudFormation's
 * automatic rollback, so a failed deploy does NOT clean up after itself: a
 * failed *first* deploy leaves the stack in `CREATE_FAILED`/`ROLLBACK_COMPLETE`
 * and a failed update can land in `UPDATE_ROLLBACK_FAILED`. In those states
 * CloudFormation refuses the next `UpdateStack`, so a plain re-run of
 * `npm run sandbox` would hit the same wall — a silent dead-end for the fast
 * loop. This spells out the exact way out instead of leaving the operator to
 * discover it via a cryptic CloudFormation error.
 *
 * Kept pure so it can be asserted in a unit test.
 */
export function sandboxFailureRecoveryHint(): string {
  return [
    "",
    "ℹ️  Express Mode leaves failed sandbox stacks in place (automatic rollback is off).",
    "   If the next `npm run sandbox` reports the stack cannot be updated, recover with:",
    "",
    "     npm run sandbox:destroy   # tears the failed stack down (handles ROLLBACK_COMPLETE)",
    "     npm run sandbox           # redeploy from a clean slate",
    "",
    "   If destroy reports UPDATE_ROLLBACK_FAILED, first run:",
    "     aws cloudformation continue-update-rollback --stack-name <your-sandbox-stack>",
  ].join("\n");
}

export async function startSandbox(options: SandboxOptions) {
  const { backendPath, outDir = ".blocks-sandbox", clientPort = 3000, devCommand, preview = false } = options;
  const deployOnly = sandboxIsDeployOnly(options);
  const sandboxStartTime = Date.now();

  // Load .env.local so CDK can read secret ARNs and other config.
  try { loadEnvFile('.env.local'); } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }

  process.env.BLOCKS_STAGE = 'sandbox';

  // Fail fast if AWS credentials are missing/expired, or the account and Region were
  // never CDK-bootstrapped, before spending ~10s in synth only to hit an opaque CDK
  // error. Unlike deploy(), startSandbox isn't wrapped in trackCommand, so emit the
  // FAIL event manually (mirroring the CDK-deploy failure path below) before
  // rethrowing — otherwise a no-creds abort sends no telemetry.
  try {
    await assertAwsCredentials({ command: 'sandbox', projectRoot: process.cwd(), checkBootstrap: true });
  } catch (error) {
    buildAndSendEvent({
      command: 'sandbox',
      state: 'FAIL',
      duration: Date.now() - sandboxStartTime,
      error: classifyError(error),
    });
    throw error;
  }

  // Provision connection string to SSM SecureString.
  // On first deploy, creates the parameter. On subsequent deploys, updates if changed.
  // projectRoot is process.cwd() — the same value passed to cdk as --context
  // projectRoot below — so the written name matches the name resolved at synth.
  const secrets = await ensureSecrets('sandbox', process.cwd());
  if (secrets.created.length > 0) {
    log.progress(`🔐 Created secrets: ${secrets.created.join(', ')}`);
  }
  if (secrets.updated.length > 0) {
    log.progress(`🔐 Updated secrets: ${secrets.updated.join(', ')}`);
  }

  // Apply external-database migrations to the sandbox database before
  // deploying. No-op unless this app uses an external DB and has ./migrations.
  await applyExternalMigrations({ stage: 'sandbox' });

  // Generate client code targeting AWS (aws-runtime condition ensures
  // the backend registers aws-middleware, not mock-middleware) — before the
  // deploy, as `deploy()` does. The same worker populates the Scope BB registry
  // for telemetry, so both the success and failure events below report the
  // app's blocks. The backend is never imported in this process: `backendPath`
  // is the CDK entry (it refuses to load without `--conditions=cdk`), and an
  // in-process import of `index.ts` would load every block's local mock.
  const backendDefPath = resolve(join(dirname(resolve(backendPath)), 'index.ts'));
  const clientPath = join(dirname(backendDefPath), 'client.js');
  log.progress('📝 Generating client code...');
  try {
    await generateDeployClient(backendDefPath, clientPath);
  } catch (error) {
    // Not wrapped in trackCommand (see the credential check above): emit FAIL.
    buildAndSendEvent({
      command: 'sandbox',
      state: 'FAIL',
      duration: Date.now() - sandboxStartTime,
      error: classifyError(error),
    });
    throw error;
  }

  // Framework resolves in the cdk synth child; it writes the value here so the
  // parent can attach it to the sandbox telemetry event.
  const frameworkSink = createFrameworkSink();

  // A preview re-deploy hotswaps (see SandboxOptions.preview). A previous
  // deploy wrote `<outDir>/outputs.json`, so the stack exists; if it was
  // destroyed since, `--hotswap-fallback` falls back to a full deploy.
  const previousOutputs = join(process.cwd(), outDir, "outputs.json");
  const hotswap = preview && existsSync(previousOutputs);

  const removalWarning = previewRemovalWarning(previousOutputs, preview);
  if (removalWarning) console.warn(removalWarning);

  log.progress("🚀 Deploying to AWS...");
  log.detail(
    hotswap
      ? "   (preview re-deploy: a backend-only change is hotswapped; a changed frontend build or infra change does a full deploy)"
      : "   (This may take a few minutes on first deploy)",
  );

  // At BLOCKS_LOG_LEVEL=quiet|normal the synth + deploy output is condensed and
  // retained; the failure path below prints it.
  const cdkOutput = createCdkOutput({ label: 'cdk synth + deploy', verb: 'deploy' });

  const cdkEnv = buildSandboxCdkEnv(frameworkSink);
  const argOptions = { outDir, projectRoot: process.cwd(), backendPath, preview };
  const assemblyDir = `${outDir}/cdk.out`;

  try {
    // Synthesize once, so the deploy decision is based on what is about to be
    // deployed (not on local state that may be missing — a fresh clone, a
    // cleaned .blocks-sandbox, another machine). The deploy below reuses this
    // assembly, so the framework build still runs only once.
    await cdkOutput.run("npm", buildSandboxSynthArgs(argOptions), { env: cdkEnv });

    // Express Mode can't UPDATE some resources (see EXPRESS_UNSAFE_RESOURCE_TYPES);
    // creating them is fine. Fall back to a full deploy when a stack about to be
    // deployed has one and already exists — or can't be inspected (fail closed).
    const expressUnsafe = await findExpressUnsafeStacks(stacksWithExpressUnsafeResources(assemblyDir));
    if (expressUnsafe.length > 0) {
      log.progress(
        `ℹ️  Express Mode off for this deploy: ${expressUnsafe.join(', ')} has a Lambda Web Function endpoint, ` +
          "which Express Mode can't update. Deploying with full stabilization + rollback instead.",
      );
    }

    await cdkOutput.run(
      "npm",
      // Argv (including sandbox-only CloudFormation Express Mode, `--express`)
      // is built by buildSandboxDeployArgs — see its doc for why each flag exists.
      buildSandboxDeployArgs({ ...argOptions, express: expressUnsafe.length === 0, assemblyDir, hotswap }),
      { env: cdkEnv },
    );
  } catch (error) {
    registerFrameworkFromSink(frameworkSink);
    buildAndSendEvent({
      command: 'sandbox',
      state: 'FAIL',
      duration: Date.now() - sandboxStartTime,
      error: { code: 'CDK_DEPLOY_FAILED', phase: 'deploy' },
    });
    cdkOutput.printRetained();
    console.error("\n❌ Deployment failed.");
    console.error(sandboxFailureRecoveryHint());
    throw error;
  }

  registerFrameworkFromSink(frameworkSink);

  const outputs = JSON.parse(readFileSync(`${outDir}/outputs.json`, "utf-8"));
  // `--all` can write more than one stack's outputs (e.g. the us-east-1 edge /
  // monitoring stacks). Pick the group that carries `ApiUrl` rather than relying
  // on the outputs file's write order; fall back to the first group so a
  // single-stack app is unchanged.
  const stackGroups = Object.values(outputs) as Record<string, string>[];
  const stackOutputs = (stackGroups.find((group) => group?.ApiUrl) ?? stackGroups[0] ?? {});

  const apiUrl = stackOutputs.ApiUrl;
  if (!apiUrl) {
    throw new Error("Could not find API URL in CDK outputs");
  }

  console.log("\n✅ Sandbox deployed!");
  console.log(`📡 API URL: ${apiUrl}`);
  const hostingUrl = findHostingUrl(stackOutputs);
  if (hostingUrl) console.log(`🌐 ${preview ? 'Preview' : 'Hosting'} URL: ${hostingUrl}`);

  buildAndSendEvent({
    command: 'sandbox',
    state: 'SUCCESS',
    duration: Date.now() - sandboxStartTime,
  });

  // Write config — just apiUrl. Client middleware gets service-specific
  // config from transferables in API responses, not from static config.
  const config: Record<string, string> = { apiUrl, environment: 'sandbox' };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/config.json`, JSON.stringify(config, null, 2));

  // Same machine-readable completion line as `npm run deploy`, so a caller can
  // grep one stable line after a sandbox deploy instead of parsing streamed
  // output. A plain sandbox serves the frontend locally, so its signal is
  // backend-only (`BLOCKS_DEPLOYED api=…`); a preview adds the hosted site's
  // `url=…`. Emitted
  // AFTER config.json is written (matching `deploy()`), so the signal always
  // implies the on-disk artifacts a consumer reads next are already present;
  // printed before the deploy-only return below so both paths emit it.
  console.log(`\n${formatDeploySignal(apiUrl, hostingUrl)}`);

  if (deployOnly) {
    return apiUrl;
  }

  log.progress("\n👀 Starting CDK watch mode...");
  log.progress("🌐 Starting local dev server (proxying to AWS)...");
  console.log(`\n   Open http://localhost:${clientPort}\n`);

  const cdkWatch = spawnCommand("npx", buildSandboxWatchArgs(argOptions), {
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group on POSIX so cleanup can reap the whole `cdk watch` tree
    // (npx → cdk → node) via terminateProcessTree, not just the npx shell — a
    // bare kill() would orphan the real cdk-watch node process, the same
    // shell-only-kill leak this PR eliminates for the dev server. Windows has no
    // groups; terminateProcessTree reaps the tree via taskkill.
    detached: process.platform !== 'win32',
    env: { ...process.env, NODE_OPTIONS: "--conditions=cdk", ...getCdkTelemetryEnv('sandbox') },
  });

  // Unchanged relay at the default level; condensed and retained (printed when
  // a watch deploy fails) at BLOCKS_LOG_LEVEL=quiet|normal.
  attachCdkWatchOutput(cdkWatch, { stopping: () => cleaningUp });

  const devServerSpawn = buildDevServerSpawn(devCommand);

  const devServer = spawnCommand(devServerSpawn.command, devServerSpawn.args, {
    stdio: "inherit",
    shell: true,
    // Own process group on POSIX so cleanup can signal the whole dev-server
    // tree (shell → tsx → node). The node dev server then runs its own SIGTERM
    // handler — the ~2s terminateFrontend drain that reaps the *detached* Vite
    // great-grandchild — which a bare `devServer.kill()` (the shell only) never
    // triggers. Windows has no groups; terminateProcessTree reaps via taskkill.
    detached: process.platform !== 'win32',
    env: { 
      ...process.env,
      NODE_OPTIONS: '',
      BLOCKS_API_URL: apiUrl,
    },
  });

  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return; // idempotent — a second signal must not re-enter
    cleaningUp = true;
    log.progress("\n\n🛑 Stopping local processes...");
    log.progress("   (AWS resources are still running)");
    log.progress("\n   To destroy AWS resources, run: npm run sandbox:destroy\n");
    // Reap BOTH child trees the way the dev server reaps Vite — a process-group
    // SIGTERM→SIGKILL via the shared terminateProcessTree — instead of a bare
    // kill() that signals only the npx/shell parent and orphans the real
    // grandchild (cdk-watch's node, or the dev server's detached Vite). Run them
    // concurrently so the cdk-watch teardown doesn't serialize on top of the dev
    // server's longer drain.
    //
    // Only the dev-server child owns the `:3100` port-free wait: its own SIGTERM
    // handler runs terminateFrontend (a ~2s drain that reaps the detached Vite
    // great-grandchild AND polls until the port frees), so we give it the longer
    // 6s budget (> that ~2s drain) — a hung dev server still escalates to a tree
    // SIGKILL and we exit regardless, so shutdown can never wedge. cdk watch
    // holds no local port, so a bounded tree-kill is all it needs.
    //
    // That a group SIGTERM (terminateProcessTree → killFrontendTree's
    // `process.kill(-pid, 'SIGTERM')`) actually reaches the *nested* node dev
    // server and runs its own SIGTERM handler — the load-bearing assumption of
    // the 6s budget above — is verified by the "group SIGTERM reaches a nested
    // node child" integration test in dev-server-supervisor.test.ts.
    await Promise.all([
      terminateProcessTree(cdkWatch, 2000),
      terminateProcessTree(devServer, 6000),
    ]);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await new Promise(() => {});
}

export async function destroySandbox(backendPath: string) {
  return trackCommand('sandbox:destroy', async () => {
    log.progress("🗑️  Destroying sandbox...");

    // Fail fast on a missing/expired credential BEFORE the retry loop: a
    // credential error is deterministic and retrying only burns the backoff.
    // Mirrors the `sandbox` deploy pre-flight; the retry is for transient
    // teardown blockers, not auth.
    await assertAwsCredentials({ command: 'sandbox:destroy', projectRoot: process.cwd(), accountDetails: false });

    // Load .env.local so CDK synth can read project refs and other config.
    try { loadEnvFile('.env.local'); } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }

    // The destroy synthesizes into this directory; the retry reads the stacks
    // it selected from there. Cleared first so a failed synth can't leave an
    // earlier run's stack list behind, and removed after a successful destroy.
    rmSync(SANDBOX_DESTROY_ASSEMBLY_DIR, { recursive: true, force: true });
    const cdkEnv = { ...process.env, NODE_OPTIONS: "--conditions=cdk", ...getCdkTelemetryEnv('sandbox') };
    const clients = await destroyRetryClients(process.cwd());
    await runDestroyWithRetries(sandboxDestroyDeps(backendPath, cdkEnv, clients));
    rmSync(SANDBOX_DESTROY_ASSEMBLY_DIR, { recursive: true, force: true });
  });
}
