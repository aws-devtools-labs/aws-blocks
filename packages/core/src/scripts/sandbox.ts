// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { ensureSecrets, loadEnvFile } from './ensure-secrets.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { environmentAccessKeys, resolveDeploymentTarget } from './deployment-target.js';
import {
  type AwsCliVersionReader,
  type CredentialFailureInText,
  credentialFailureMessage,
} from './credential-guidance.js';
import { applyExternalMigrations } from './external-migrations-step.js';
import { trackCommand } from '../telemetry/trackCommand.js';
import { buildAndSendEvent } from '../telemetry/client.js';
import { classifyError } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv, getFrameworkSinkEnv } from './cdk-telemetry-env.js';
import { createFrameworkSink, registerFrameworkFromSink } from '../telemetry/framework-sink.js';
import {
  type CdkOutputStream,
  createDenialMonitor,
  createLineAssembler,
  formatDenialNotice,
  formatDeploySignal,
  type OutputSink,
} from './deploy-stream.js';
import { runPipingStderr, runSync, spawnCommand } from './run-command.js';
import { terminateProcessTree } from './process-tree.js';
import { generateDeployClient } from './deploy-client-codegen.js';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import type { S3Client } from '@aws-sdk/client-s3';

export interface SandboxOptions {
  backendPath: string;
  outDir?: string;
  clientPort?: number;
  deployOnly?: boolean;
  /** Custom dev server command. Defaults to 'npx vite'. For Next.js use 'npx next dev'. */
  devCommand?: string;
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
}

/**
 * Build the `npm exec cdk -- synth …` argv the sandbox runs first: synthesize
 * once into `<outDir>/cdk.out`, inspect the templates (see
 * {@link stacksWithExpressUnsafeResources}), then deploy that assembly.
 */
export function buildSandboxSynthArgs({ outDir, projectRoot, backendPath }: SandboxDeployArgsOptions): string[] {
  return [
    "exec", "cdk", "--", "synth",
    "--quiet",
    "--output", `${outDir}/cdk.out`,
    "--context", `projectRoot=${projectRoot}`,
    "--context", "sandboxMode=true",
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
 * - `--progress events`: one line per resource event instead of the redrawn
 *   progress bar. {@link startSandbox} reads the deploy's stderr, where the CDK
 *   CLI writes its progress, to explain authorization failures, so that stream
 *   is not a terminal: the bar would redraw itself without the terminal's width
 *   and height. Event lines are what the CDK CLI prints whenever it has no
 *   terminal (CI, Windows, a pipe), and what the production deploy prints.
 */
export function buildSandboxDeployArgs({
  outDir,
  projectRoot,
  backendPath,
  express = true,
  assemblyDir,
}: SandboxDeployArgsOptions): string[] {
  return [
    "exec", "cdk", "--", "deploy",
    "--all",
    "--method", "direct",
    ...(express ? ["--express"] : []),
    "--require-approval", "never",
    "--progress", "events",
    "--outputs-file", `${outDir}/outputs.json`,
    "--context", `projectRoot=${projectRoot}`,
    "--context", "sandboxMode=true",
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

/**
 * Recovery guidance printed instead of {@link sandboxFailureRecoveryHint} when a
 * sandbox deploy failed because AWS denied a request (explained just before by
 * {@link formatDenialNotice}). Running the deploy again does not get past the
 * denial until its cause is resolved, and destroying a sandbox that existed
 * before deletes its data, so the Express Mode note does not fit. Whether this
 * deploy was the sandbox's first is not read from the output, so both cases
 * are stated.
 *
 * Kept pure so it can be asserted in a unit test.
 */
export function sandboxDenialRecoveryHint(): string {
  return [
    "",
    "ℹ️  If this was the first deploy of this sandbox, the stack it left holds no data; `npm run sandbox:destroy` removes it.",
    "   If the sandbox existed before, do not destroy it (that deletes its data): run `npm run sandbox` again once the cause above is resolved.",
  ].join("\n");
}

/** Input for {@link sandboxCredentialFailureMessage}; the defaults are the real environment. */
export interface SandboxCredentialMessageOptions {
  /** The failure happened in `cdk watch`, which keeps running (see `credentialFailureMessage`). */
  watching?: boolean;
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
  readAwsCliVersion?: AwsCliVersionReader;
}

/**
 * The source-aware sign-in guidance for a credential failure that the CDK CLI
 * reported during the sandbox deploy or `cdk watch`: the message of the
 * pre-deploy credential check, for the same deployment target. As there, with
 * access keys in the environment (and no profile in `cdk.json`), CDK deploys
 * with those keys, so the guidance is about them, under the `AWS_` names it
 * reads. Nothing here signs in, prompts or opens a browser.
 */
export async function sandboxCredentialFailureMessage(
  { errorName, failure }: CredentialFailureInText,
  { watching = false, env = process.env, projectRoot = process.cwd(), readAwsCliVersion }: SandboxCredentialMessageOptions = {},
): Promise<string> {
  let region: string | undefined;
  let profile: string | undefined;
  try {
    const target = await resolveDeploymentTarget({ env, projectRoot });
    region = target.region ?? undefined;
    profile = target.profile;
  } catch {
    // An unreadable cdk.json: the guidance names the source without the target.
  }
  const environmentKeys = profile ? undefined : environmentAccessKeys(env);
  return credentialFailureMessage({
    command: 'sandbox',
    errorName,
    failure,
    env: environmentKeys
      ? {
          ...env,
          AWS_PROFILE: undefined,
          AWS_DEFAULT_PROFILE: undefined,
          AWS_ACCESS_KEY_ID: environmentKeys.accessKeyId,
          AWS_SECRET_ACCESS_KEY: environmentKeys.secretAccessKey,
          AWS_SESSION_TOKEN: environmentKeys.sessionToken,
        }
      : env,
    profile,
    readAwsCliVersion,
    region,
    watching,
  });
}

/** Relays the initial sandbox deploy's stderr; see {@link createSandboxDeployObserver}. */
export interface SandboxDeployObserver {
  /** Relay one chunk of the deploy's stderr. */
  write(chunk: string): void;
  /** The deploy's stderr ended: read a last line that has no newline. */
  end(): void;
  /** The deploy failed: explain a denial that was held until then. */
  failed(): void;
  /** Whether a denial notice was printed. */
  denied(): boolean;
  /** The credential failure that the output showed, if any; its guidance is printed by the caller. */
  credentialFailure(): CredentialFailureInText | undefined;
}

/**
 * Relay the initial sandbox deploy's stderr to `out` and read it, for
 * {@link startSandbox}.
 *
 * Capture strategy: the deploy keeps this process's stdin and stdout (see
 * {@link runPipingStderr}), so the CDK CLI, which decides colors and its
 * terminal behavior from stdout, sees the same terminal as before. Only stderr
 * is piped; without `--ci` the CDK CLI writes all of its progress and errors
 * there. Each chunk is written to `out` unchanged as soon as it arrives, so
 * colors, partial lines and CRLF line endings pass through as they are. The
 * chunks are also split into lines (across chunk boundaries) for a
 * {@link createDenialMonitor}. A denial notice is printed right after the line
 * that showed the denial, never inside a line. A credential failure is only
 * recorded: its guidance needs the deployment target, so {@link startSandbox}
 * prints it once the deploy has failed.
 *
 * In CI mode (`CI` set) the CDK CLI moves its progress, including the
 * CloudFormation events, to stdout, which stays inherited and is not read. Its
 * error block still goes to stderr, so a denial is then explained from that
 * block when the deploy fails, not at the resource's `CREATE_FAILED` event.
 */
export function createSandboxDeployObserver(out: OutputSink = process.stderr): SandboxDeployObserver {
  const assembler = createLineAssembler();
  const notices: string[] = [];
  let denied = false;
  let credentialFailure: CredentialFailureInText | undefined;
  let atLineStart = true;
  const monitor = createDenialMonitor(
    (kind) => {
      denied = true;
      notices.push(formatDenialNotice(kind, 'sandbox'));
    },
    {
      onCredentialFailure: (failure) => {
        credentialFailure = failure;
      },
    },
  );
  const observe = (lines: string[]): void => {
    for (const line of lines) monitor.observe(line, 'stderr');
  };
  const printNotices = (): void => {
    if (notices.length === 0) return;
    if (!atLineStart) out.write("\n");
    for (const notice of notices.splice(0)) out.write(`${notice}\n`);
    atLineStart = true;
  };
  return {
    write(chunk) {
      if (chunk === "") return;
      observe(assembler.push(chunk));
      // A notice comes from a line that this chunk completed: print it after
      // that line's newline and before the start of the next line.
      const lineEnd = notices.length > 0 ? chunk.lastIndexOf("\n") + 1 : chunk.length;
      out.write(chunk.slice(0, lineEnd));
      if (lineEnd < chunk.length) {
        atLineStart = true;
        printNotices();
        out.write(chunk.slice(lineEnd));
      }
      atLineStart = chunk.endsWith("\n");
      printNotices();
    },
    end() {
      observe(assembler.flush());
      printNotices();
    },
    failed() {
      monitor.failed();
      printNotices();
    },
    denied: () => denied,
    credentialFailure: () => credentialFailure,
  };
}

/** A `cdk watch` output stream (a child process's stdout or stderr). */
export interface CdkWatchStream {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: string, listener: (chunk: string) => void): unknown;
}

/** Where {@link relayCdkWatchOutput} prints. */
export interface CdkWatchSinks {
  log(text: string): void;
  error(text: string): void;
}

/** What {@link relayCdkWatchOutput} returns. */
export interface CdkWatchRelay {
  /** Resolves once the credential guidance started so far has been printed. */
  idle(): Promise<void>;
}

// Lambda request markers that `cdk watch` streams from the function's logs.
const LAMBDA_REQUEST_LOG = /\[(START|END|REPORT|INIT_START)\s+RequestId:/;

/**
 * Relay `cdk watch` output, piped as before: each chunk is printed trimmed with
 * a `[CDK Watch]` prefix (stdout without Lambda request markers through `log`,
 * stderr through `error`). The chunks are also split into lines for a
 * {@link createDenialMonitor}, which counts each deployment that `cdk watch`
 * starts as a new attempt, so an authorization failure is explained once per
 * deployment, through `error`, right after the chunk that showed it.
 *
 * Credentials can expire while `cdk watch` runs. A failed deploy does not stop
 * it; it shows the failed asset upload. A credential failure is explained once
 * per deployment, through `error`, with the source-aware guidance from
 * `credentialMessage` ({@link sandboxCredentialFailureMessage} by default),
 * which says whether saving a file or restarting picks up new credentials.
 */
export function relayCdkWatchOutput(
  child: { stdout?: CdkWatchStream | null; stderr?: CdkWatchStream | null },
  sinks: CdkWatchSinks = { log: (text) => console.log(text), error: (text) => console.error(text) },
  credentialMessage: (failure: CredentialFailureInText) => Promise<string> = (failure) =>
    sandboxCredentialFailureMessage(failure, { watching: true }),
): CdkWatchRelay {
  const notices: string[] = [];
  // Guidance is printed in order, after the output that led to it.
  let printing = Promise.resolve();
  const monitor = createDenialMonitor((kind) => notices.push(formatDenialNotice(kind, 'sandbox')), {
    onCredentialFailure: (failure) => {
      printing = printing.then(async () => sinks.error(await credentialMessage(failure)));
    },
  });
  const relay = (
    stream: CdkWatchStream | null | undefined,
    source: CdkOutputStream,
    print: (chunk: string) => void,
  ): void => {
    if (!stream) return;
    const assembler = createLineAssembler();
    const observe = (lines: string[]): void => {
      for (const line of lines) monitor.observe(line, source);
      for (const notice of notices.splice(0)) sinks.error(notice);
    };
    stream.setEncoding('utf-8');
    stream.on('data', (chunk) => {
      print(chunk);
      observe(assembler.push(chunk));
    });
    stream.on('end', () => observe(assembler.flush()));
  };
  relay(child.stdout, 'stdout', (chunk) => {
    const str = chunk.trim();
    if (!LAMBDA_REQUEST_LOG.test(str)) sinks.log(`[CDK Watch] ${str}`);
  });
  relay(child.stderr, 'stderr', (chunk) => sinks.error(`[CDK Watch] ${chunk.trim()}`));
  return { idle: () => printing };
}

export async function startSandbox(options: SandboxOptions) {
  const { backendPath, outDir = ".blocks-sandbox", clientPort = 3000, deployOnly = false, devCommand } = options;
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
    console.log(`🔐 Created secrets: ${secrets.created.join(', ')}`);
  }
  if (secrets.updated.length > 0) {
    console.log(`🔐 Updated secrets: ${secrets.updated.join(', ')}`);
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
  console.log('📝 Generating client code...');
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
  console.log("🚀 Deploying to AWS...");
  console.log("   (This may take a few minutes on first deploy)");

  const cdkEnv = buildSandboxCdkEnv(frameworkSink);
  const argOptions = { outDir, projectRoot: process.cwd(), backendPath };
  const assemblyDir = `${outDir}/cdk.out`;
  // Reads the deploy's stderr while relaying it unchanged, to explain an
  // authorization failure as soon as the CDK CLI prints it (see
  // createSandboxDeployObserver for the capture).
  const deployOutput = createSandboxDeployObserver();

  try {
    // Synthesize once, so the deploy decision is based on what is about to be
    // deployed (not on local state that may be missing — a fresh clone, a
    // cleaned .blocks-sandbox, another machine). The deploy below reuses this
    // assembly, so the framework build still runs only once.
    runSync("npm", buildSandboxSynthArgs(argOptions), { stdio: "inherit", env: cdkEnv });

    // Express Mode can't UPDATE some resources (see EXPRESS_UNSAFE_RESOURCE_TYPES);
    // creating them is fine. Fall back to a full deploy when a stack about to be
    // deployed has one and already exists — or can't be inspected (fail closed).
    const expressUnsafe = await findExpressUnsafeStacks(stacksWithExpressUnsafeResources(assemblyDir));
    if (expressUnsafe.length > 0) {
      console.log(
        `ℹ️  Express Mode off for this deploy: ${expressUnsafe.join(', ')} has a Lambda Web Function endpoint, ` +
          "which Express Mode can't update. Deploying with full stabilization + rollback instead.",
      );
    }

    await runPipingStderr(
      "npm",
      // Argv (including sandbox-only CloudFormation Express Mode, `--express`)
      // is built by buildSandboxDeployArgs — see its doc for why each flag exists.
      buildSandboxDeployArgs({ ...argOptions, express: expressUnsafe.length === 0, assemblyDir }),
      { env: cdkEnv },
      (chunk) => deployOutput.write(chunk),
    );
    deployOutput.end();
  } catch (error) {
    registerFrameworkFromSink(frameworkSink);
    buildAndSendEvent({
      command: 'sandbox',
      state: 'FAIL',
      duration: Date.now() - sandboxStartTime,
      error: { code: 'CDK_DEPLOY_FAILED', phase: 'deploy' },
    });
    // An authorization failure is explained first (the notice is printed by
    // now); the Express Mode recovery does not fit it, so it gets its own.
    deployOutput.end();
    deployOutput.failed();
    // Expired or rejected credentials (they were valid at the pre-deploy check):
    // the same source-aware guidance as that check, for this deployment target.
    const credentials = deployOutput.credentialFailure();
    if (credentials) console.error(`\n${await sandboxCredentialFailureMessage(credentials)}`);
    console.error("\n❌ Deployment failed.");
    console.error(deployOutput.denied() ? sandboxDenialRecoveryHint() : sandboxFailureRecoveryHint());
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
  // output. Sandbox serves the frontend locally (no CloudFront), so there is no
  // hosting URL — the signal is backend-only (`BLOCKS_DEPLOYED api=…`). Emitted
  // AFTER config.json is written (matching `deploy()`), so the signal always
  // implies the on-disk artifacts a consumer reads next are already present;
  // printed before the deploy-only return below so both paths emit it.
  console.log(`\n${formatDeploySignal(apiUrl)}`);

  if (deployOnly) {
    return apiUrl;
  }

  console.log("\n👀 Starting CDK watch mode...");
  console.log("🌐 Starting local dev server (proxying to AWS)...");
  console.log(`\n   Open http://localhost:${clientPort}\n`);

  const cdkWatch = spawnCommand("npx", [
    "cdk", "watch",
    `--outputs-file`, `${outDir}/outputs.json`,
    `--context`, `projectRoot=${process.cwd()}`,
    `--context`, `sandboxMode=true`,
    `--app`, `npm exec tsx -- -C cdk ${backendPath}`
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group on POSIX so cleanup can reap the whole `cdk watch` tree
    // (npx → cdk → node) via terminateProcessTree, not just the npx shell — a
    // bare kill() would orphan the real cdk-watch node process, the same
    // shell-only-kill leak this PR eliminates for the dev server. Windows has no
    // groups; terminateProcessTree reaps the tree via taskkill.
    detached: process.platform !== 'win32',
    env: { ...process.env, NODE_OPTIONS: "--conditions=cdk", ...getCdkTelemetryEnv('sandbox') },
  });

  // Piped (not inherited) so the Lambda request markers can be filtered out, and
  // read for authorization failures, explained once per deployment that
  // `cdk watch` starts.
  relayCdkWatchOutput(cdkWatch);

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
    console.log("\n\n🛑 Stopping local processes...");
    console.log("   (AWS resources are still running)");
    console.log("\n   To destroy AWS resources, run: npm run sandbox:destroy\n");
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

/**
 * Flatten a ListObjectVersions response into the `{ Key, VersionId }[]` shape
 * DeleteObjects expects, combining live versions AND delete markers. Exported
 * for unit testing — getting this combination wrong (e.g. missing the delete
 * markers) leaves a "versioned" bucket that still can't be deleted.
 */
export function toDeleteObjects(listed: {
	Versions?: Array<{ Key?: string; VersionId?: string }>;
	DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
}): Array<{ Key: string; VersionId?: string }> {
	return [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
		.filter((v): v is { Key: string; VersionId?: string } => v.Key !== undefined)
		.map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
}

/** Collect a stack's S3 bucket physical names (paginated — a large stack has
 * >100 resources, so a single page can miss the hosting bucket that blocks the
 * delete). Returns [] if the stack is already gone / not accessible. */
export async function listStackBucketNames(cfn: CloudFormationClient, stackName: string): Promise<string[]> {
	const { ListStackResourcesCommand } = await import('@aws-sdk/client-cloudformation');
	const buckets: string[] = [];
	let token: string | undefined;
	do {
		const res = await cfn.send(new ListStackResourcesCommand({ StackName: stackName, NextToken: token }));
		for (const r of res.StackResourceSummaries ?? []) {
			if (r.ResourceType === 'AWS::S3::Bucket' && r.PhysicalResourceId) buckets.push(r.PhysicalResourceId);
		}
		token = res.NextToken;
	} while (token);
	return buckets;
}

/**
 * Resource types CloudFormation Express Mode can't UPDATE. Re-pointing a
 * Lambda Web Function endpoint's `RevisionWeights` at a new revision fails
 * there with "RevisionWeights: expected minimum item count: 1, found: 0" (a
 * plain update with rollback succeeds), and Express Mode's disabled rollback
 * then leaves the stack stuck in UPDATE_FAILED. Creates are unaffected.
 */
export const EXPRESS_UNSAFE_RESOURCE_TYPES: ReadonlySet<string> = new Set(['AWS::Lambda::WebFunctionEndpoint']);

/** A stack in a synthesized cloud assembly. `region` is unset for environment-agnostic stacks. */
export interface AssemblyStack {
	stackName: string;
	region?: string;
}

/** A stack artifact in a cloud assembly's `manifest.json`. */
type StackArtifact = {
	type?: string;
	environment?: string;
	displayName?: string;
	properties?: { templateFile?: string; stackName?: string };
};

/**
 * The stack artifacts listed in `manifest.json` of the synthesized assembly at
 * `assemblyDir`, as `[artifactId, artifact]`: the top-level stacks (a stack
 * inside a CDK `Stage` lives in a nested assembly and is not listed). [] if the
 * assembly can't be read.
 */
function readStackArtifacts(assemblyDir: string): Array<[string, StackArtifact]> {
	let artifacts: Record<string, StackArtifact>;
	try {
		artifacts = (JSON.parse(readFileSync(join(assemblyDir, 'manifest.json'), 'utf-8')) as { artifacts?: Record<string, StackArtifact> })
			.artifacts ?? {};
	} catch {
		return [];
	}
	return Object.entries(artifacts).filter(([, artifact]) => artifact.type === 'aws:cloudformation:stack');
}

/** The CloudFormation stack name and Region of a stack artifact. */
function toAssemblyStack(id: string, artifact: StackArtifact): AssemblyStack {
	const region = artifact.environment?.split('/')[3];
	return {
		stackName: artifact.properties?.stackName ?? id,
		region: region && region !== 'unknown-region' ? region : undefined,
	};
}

/**
 * The top-level stacks of the synthesized assembly at `assemblyDir`, by
 * CloudFormation stack name and Region: the stacks `cdk deploy --all` and
 * `cdk destroy --all` select. Unlike `cdk ls`, which prints construct paths
 * (`Parent/Nested`) and also lists stacks inside a CDK `Stage`, these are the
 * names CloudFormation knows, each with its own Region (a Lambda@Edge
 * `edge-lambda-stack-*` is always in us-east-1). [] if the assembly can't be read.
 */
export function topLevelStacks(assemblyDir: string): AssemblyStack[] {
	return readStackArtifacts(assemblyDir).map(([id, artifact]) => toAssemblyStack(id, artifact));
}

/**
 * The stacks in the synthesized assembly at `assemblyDir` whose template
 * contains a resource in {@link EXPRESS_UNSAFE_RESOURCE_TYPES}. Reads
 * `manifest.json` + each stack's template; [] if the assembly can't be read.
 */
export function stacksWithExpressUnsafeResources(assemblyDir: string): AssemblyStack[] {
	const stacks: AssemblyStack[] = [];
	for (const [id, artifact] of readStackArtifacts(assemblyDir)) {
		if (!artifact.properties?.templateFile) continue;
		let template: { Resources?: Record<string, { Type?: string }> };
		try {
			template = JSON.parse(readFileSync(join(assemblyDir, artifact.properties.templateFile), 'utf-8'));
		} catch {
			continue;
		}
		const hasUnsafe = Object.values(template.Resources ?? {}).some((r) => EXPRESS_UNSAFE_RESOURCE_TYPES.has(r.Type ?? ''));
		if (!hasUnsafe) continue;
		stacks.push(toAssemblyStack(id, artifact));
	}
	return stacks;
}

/**
 * The stacks (of `stacks`, each containing a resource Express Mode can't
 * update) that already exist — so this deploy would UPDATE them. Fails closed:
 * any error other than "stack does not exist" (credentials, throttling, access)
 * counts as existing, so a deploy never risks Express Mode's unrecoverable
 * UPDATE_FAILED state on a guess.
 */
export async function findExpressUnsafeStacks(
	stacks: AssemblyStack[],
	cfnFor?: (region: string | undefined) => CloudFormationClient,
): Promise<string[]> {
	if (stacks.length === 0) return [];
	const { CloudFormationClient: Client, DescribeStacksCommand } = await import('@aws-sdk/client-cloudformation');
	const clientFor = cfnFor ?? ((region: string | undefined) => new Client(region ? { region } : {}));
	const unsafe: string[] = [];
	for (const { stackName, region } of stacks) {
		try {
			const res = await clientFor(region).send(new DescribeStacksCommand({ StackName: stackName }));
			const status = res.Stacks?.[0]?.StackStatus;
			if (status && status !== 'DELETE_COMPLETE') unsafe.push(stackName);
		} catch (e) {
			const message = (e as Error).message ?? '';
			if (!/does not exist/i.test(message)) unsafe.push(stackName);
		}
	}
	return unsafe;
}

/** Empty a versioned bucket: delete every object version + delete marker in
 * pages of 1000 (the DeleteObjects limit). Stops if a page reports per-key
 * errors (object-lock / retention) so it can't loop forever. */
export async function emptyBucket(s3: S3Client, bucket: string): Promise<void> {
	const { ListObjectVersionsCommand, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
	while (true) {
		const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }));
		const objects = toDeleteObjects(listed);
		if (objects.length === 0) return;
		const res = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
		if (res.Errors && res.Errors.length > 0) {
			// A bucket we can't fully empty (object-lock / retention / AccessDenied)
			// will keep blocking `cdk destroy`, so the stack won't tear down until it's
			// resolved by hand. Log loudly with the first error code — this is the
			// kind of silent skip that leaks a stack, so make it visible in CI output.
			const first = res.Errors[0];
			console.warn(
				`  ⚠️  ${bucket}: ${res.Errors.length} object(s) could NOT be deleted ` +
					`(e.g. ${first.Key}: ${first.Code}). This bucket will block stack teardown ` +
					`until cleared manually.`,
			);
			return;
		}
	}
}

/** Clients {@link emptySandboxBuckets} uses; injectable for tests. */
export interface EmptyBucketsClients {
	/** CloudFormation client for a Region (`undefined`: the default Region). */
	cfnFor?: (region: string | undefined) => CloudFormationClient;
	s3?: S3Client;
}

/**
 * The AWS clients a destroy's retry uses, aimed at the account and Region CDK
 * destroys in: SDK v3 clients don't read `cdk.json` or `AWS_DEFAULT_PROFILE`
 * (see {@link resolveDeploymentTarget}), so default clients could look in
 * another Region or account and find nothing. A stack pinned to a Region (the
 * us-east-1 Lambda@Edge stack) is still looked up in its own Region.
 */
export async function destroyRetryClients(projectRoot: string): Promise<Required<EmptyBucketsClients>> {
	const target = await resolveDeploymentTarget({ projectRoot });
	const { CloudFormationClient } = await import('@aws-sdk/client-cloudformation');
	const { S3Client } = await import('@aws-sdk/client-s3');
	const region = target.region ?? undefined;
	const cfnByRegion = new Map<string | undefined, CloudFormationClient>();
	return {
		cfnFor: (stackRegion) => {
			const key = stackRegion ?? region;
			let cfn = cfnByRegion.get(key);
			if (!cfn) {
				cfn = new CloudFormationClient({ region: key, profile: target.profile });
				cfnByRegion.set(key, cfn);
			}
			return cfn;
		},
		s3: new S3Client({ region, profile: target.profile, followRegionRedirects: true }),
	};
}

/**
 * Empty every versioned S3 bucket owned by the given stacks. `cdk destroy`
 * relies on each bucket's `autoDeleteObjects` custom-resource Lambda to empty
 * it on teardown — but that Lambda never provisions if the CREATE failed (e.g.
 * a partial/aborted deploy), so the versioned bucket blocks the delete and the
 * stack (and its IAM roles) leak. Emptying out-of-band before the retry lets
 * the delete complete. Best-effort: any per-stack/per-bucket error is logged
 * and skipped so teardown still proceeds. Exported so the production destroy
 * path ({@link ./destroy.ts}) reuses the same bucket-emptying step.
 *
 * Each stack's resources are listed in that stack's own Region (see
 * {@link topLevelStacks}), so a stack outside the default Region, such as a
 * us-east-1 Lambda@Edge `edge-lambda-stack-*`, is not skipped as "not found".
 */
export async function emptySandboxBuckets(stacks: AssemblyStack[], clients: EmptyBucketsClients = {}): Promise<void> {
	try {
		const { CloudFormationClient } = await import('@aws-sdk/client-cloudformation');
		const { S3Client } = await import('@aws-sdk/client-s3');
		const cfnFor = clients.cfnFor ?? ((region: string | undefined) => new CloudFormationClient(region ? { region } : {}));
		const cfnByRegion = new Map<string | undefined, CloudFormationClient>();
		// `followRegionRedirects` makes the client transparently retry against a
		// bucket's real region on a PermanentRedirect, so a bucket that lives
		// outside AWS_REGION (e.g. a us-east-1 Lambda@Edge stack's bucket) is still
		// emptied instead of failing silently — closing the exact no-op this fix
		// targets. It needs no GetBucketLocation permission.
		const s3 = clients.s3 ?? new S3Client({ followRegionRedirects: true });
		for (const { stackName, region } of stacks) {
			let cfn = cfnByRegion.get(region);
			if (!cfn) {
				cfn = cfnFor(region);
				cfnByRegion.set(region, cfn);
			}
			let buckets: string[] = [];
			try {
				buckets = await listStackBucketNames(cfn, stackName);
			} catch {
				continue; // stack already gone / not accessible
			}
			for (const b of buckets) {
				try {
					await emptyBucket(s3, b);
				} catch (e) {
					console.warn(`  ⚠️  could not empty ${b}: ${(e as Error).message}`);
				}
			}
		}
	} catch (e) {
		console.warn(`  ⚠️  bucket-emptying step skipped: ${(e as Error).message}`);
	}
}

/**
 * The stacks of the assembly a `cdk destroy --output <assemblyDir>` attempt
 * synthesized (see {@link topLevelStacks}): the set that `--all` deletes, by
 * stack name and Region. Warns when the assembly can't be read (the synth
 * failed), since an empty list skips the bucket-emptying before the retry.
 */
export function listDestroyedStacks(assemblyDir: string): AssemblyStack[] {
	const stacks = topLevelStacks(assemblyDir);
	if (stacks.length === 0) {
		console.warn(
			`  ⚠️  could not read the synthesized stacks in ${assemblyDir}; skipping bucket-emptying and the throttle and ` +
				'Lambda@Edge checks',
		);
	}
	return stacks;
}

/**
 * Whether a CloudFormation resource status reason says an AWS API throttled
 * the call, e.g. `Too Many Requests (Service: ApiGateway, Status Code: 429)`
 * (DeleteRestApi is limited to one request every 30s per account),
 * `Rate exceeded (... Error Code: Throttling)`, EC2 `RequestLimitExceeded` or
 * S3 `SlowDown`. Case-sensitive and matched on the services' error-token
 * shapes, so a resource name that merely contains "throttling" does not match.
 */
export function isThrottleReason(reason: string | undefined): boolean {
	return /\bToo Many Requests\b|\bStatus Code: 429\b|\bTooManyRequestsException\b|\bThrottlingException\b|\bError Code: Throttling\b|\bRate [Ee]xceeded\b|\bRequestLimitExceeded\b|\bError Code: SlowDown\b|\bRequest was throttled\b/.test(
		reason ?? '',
	);
}

/** Clock skew allowed between this machine and CloudFormation event timestamps. */
const EVENT_CLOCK_SKEW_MS = 60_000;
/** DescribeStackEvents pages read per stack before giving up on finding this attempt's start. */
const MAX_EVENT_PAGES = 30;

/**
 * Whether the delete attempt that began at `sinceMs` failed because AWS
 * throttled a resource delete in any of `stacks`. Reads each stack's
 * events newest-first back to this attempt's own stack-level
 * `DELETE_IN_PROGRESS` and counts a throttle only if that start event is found
 * and is no older than `sinceMs` (less clock skew) nor than `notBeforeMs`
 * (the previous attempt's failure, when there was one), so a throttle left
 * over from an earlier attempt is not counted. Stack-level events (the stack's
 * "failed to delete: [ids]" summary, nested stacks) are never read as a
 * throttle. A stack that no longer exists is skipped; any other error (or
 * every stack missing, e.g. stacks in another Region) is thrown after checking
 * the remaining stacks, so the caller can warn and fall back to the ordinary
 * retry schedule.
 *
 * `cfn` is one client for every stack, or a client per Region: then each
 * stack given as an {@link AssemblyStack} is looked up in its own Region (the
 * us-east-1 Lambda@Edge stack of an app deployed elsewhere).
 */
export async function stackDeleteThrottled(
	cfn: CloudFormationClient | ((region: string | undefined) => CloudFormationClient),
	stacks: Array<string | AssemblyStack>,
	sinceMs: number,
	notBeforeMs?: number,
): Promise<boolean> {
	const { DescribeStackEventsCommand } = await import('@aws-sdk/client-cloudformation');
	const oldest = Math.max(sinceMs - EVENT_CLOCK_SKEW_MS, notBeforeMs ?? Number.NEGATIVE_INFINITY);
	const stackNames = stacks.map((st) => (typeof st === 'string' ? st : st.stackName));
	let firstError: unknown;
	let missing = 0;
	for (const stack of stacks) {
		const { stackName, region } = typeof stack === 'string' ? { stackName: stack, region: undefined } : stack;
		const client = typeof cfn === 'function' ? cfn(region) : cfn;
		try {
			let nextToken: string | undefined;
			let sawThrottle = false;
			scan: for (let page = 0; page < MAX_EVENT_PAGES; page++) {
				const res = await client.send(new DescribeStackEventsCommand({ StackName: stackName, NextToken: nextToken }));
				for (const ev of res.StackEvents ?? []) {
					if (ev.Timestamp && ev.Timestamp.getTime() < oldest) break scan;
					if (ev.ResourceType === 'AWS::CloudFormation::Stack') {
						if (ev.LogicalResourceId === stackName && ev.ResourceStatus === 'DELETE_IN_PROGRESS') {
							if (sawThrottle) return true;
							break scan;
						}
						continue;
					}
					if (ev.ResourceStatus === 'DELETE_FAILED' && isThrottleReason(ev.ResourceStatusReason)) sawThrottle = true;
				}
				nextToken = res.NextToken;
				if (!nextToken) break;
			}
		} catch (e) {
			if (/does not exist/i.test((e as Error).message ?? '')) missing++;
			else firstError ??= e;
		}
	}
	if (firstError !== undefined) throw firstError;
	if (stackNames.length > 0 && missing === stackNames.length) {
		throw new Error(`none of the stacks (${stackNames.join(', ')}) were found (already deleted, never deployed, or in another Region)`);
	}
	return false;
}

/**
 * {@link stackDeleteThrottled} with a CloudFormation client per Region: the
 * real `isThrottled` for both destroy paths (`destroySandbox` here and the
 * production `destroy` in `./destroy.ts`). `destroySandbox` passes the clients
 * of {@link destroyRetryClients}; without `cfnFor`, each stack's own Region or
 * else the SDK's default Region and credentials are used.
 */
export async function destroyWasThrottled(
	stacks: AssemblyStack[],
	sinceMs: number,
	notBeforeMs?: number,
	cfnFor?: (region: string | undefined) => CloudFormationClient,
): Promise<boolean> {
	if (stacks.length === 0) return false;
	const { CloudFormationClient } = await import('@aws-sdk/client-cloudformation');
	const clientFor = cfnFor ?? ((region: string | undefined) => new CloudFormationClient(region ? { region } : {}));
	return stackDeleteThrottled(clientFor, stacks, sinceMs, notBeforeMs);
}

/** Backoff for a destroy that failed on an AWS API throttle. */
export interface ThrottleBackoff {
	/** First backoff step, before jitter. Default: 1min. */
	baseMs?: number;
	/** Ceiling for one backoff step, before jitter. Default: 5min. */
	maxDelayMs?: number;
	/**
	 * No further throttle retry is scheduled once its wait would end more than
	 * this long after the first failure (the retry attempt itself runs after
	 * that). Default: 20min.
	 */
	budgetMs?: number;
}

const THROTTLE_BACKOFF_DEFAULTS: Required<ThrottleBackoff> = {
	baseMs: 60_000,
	maxDelayMs: 300_000,
	budgetMs: 20 * 60_000,
};

/**
 * The wait before throttle retry number `retry` (0-based): exponential
 * (`baseMs * 2^retry`, capped at `maxDelayMs`) with equal jitter, i.e. a
 * random point in `[step/2, step]`. The jitter spreads parallel destroys in
 * one account apart, so they stop retrying DeleteRestApi in lockstep.
 */
export function throttleBackoffDelay(retry: number, backoff: ThrottleBackoff, random: () => number): number {
	const { baseMs, maxDelayMs } = { ...THROTTLE_BACKOFF_DEFAULTS, ...backoff };
	const step = Math.min(maxDelayMs, baseMs * 2 ** retry);
	return Math.round(step / 2 + random() * (step / 2));
}

/** Whether `stackName` is the us-east-1 stack CDK adds for a Lambda@Edge function (`edge-lambda-stack-*`). */
export function isEdgeLambdaStack(stackName: string): boolean {
	return stackName.startsWith('edge-lambda-stack-');
}

/**
 * The Lambda@Edge stacks (of `stacks`, see {@link isEdgeLambdaStack}) whose
 * delete failed because CloudFront still replicates their function: a
 * resource in `DELETE_FAILED` whose reason says it "is a replicated function",
 * updated no earlier than `sinceMs` (epoch ms, less a minute of clock skew), so
 * a failure left over from an earlier run is not counted. Each stack is looked
 * up in its own Region. A stack that can't be listed (gone, no access,
 * throttled) is not counted, so the caller falls back to its ordinary retries.
 */
export async function edgeStacksBlockedByReplicas(
	stacks: AssemblyStack[],
	sinceMs: number,
	cfnFor?: (region: string | undefined) => CloudFormationClient,
): Promise<string[]> {
	const edgeStacks = stacks.filter((s) => isEdgeLambdaStack(s.stackName));
	if (edgeStacks.length === 0) return [];
	const { CloudFormationClient: Client, ListStackResourcesCommand } = await import('@aws-sdk/client-cloudformation');
	const clientFor = cfnFor ?? ((region: string | undefined) => new Client(region ? { region } : {}));
	const blocked: string[] = [];
	for (const { stackName, region } of edgeStacks) {
		try {
			let token: string | undefined;
			let replicated = false;
			do {
				const res = await clientFor(region).send(new ListStackResourcesCommand({ StackName: stackName, NextToken: token }));
				replicated ||= (res.StackResourceSummaries ?? []).some(
					(r) =>
						r.ResourceStatus === 'DELETE_FAILED' &&
						/replicated function/i.test(r.ResourceStatusReason ?? '') &&
						(r.LastUpdatedTimestamp?.getTime() ?? Number.NEGATIVE_INFINITY) >= sinceMs - EVENT_CLOCK_SKEW_MS,
				);
				token = res.NextToken;
			} while (token && !replicated);
			if (replicated) blocked.push(stackName);
		} catch {
			// Not listable: leave it to the ordinary retries.
		}
	}
	return blocked;
}

/** Injectable dependencies for {@link runDestroyWithRetries} — real ones in
 * `destroySandbox`, fakes in tests so the retry/empty-before-retry wiring (the
 * sev2 fix) is exercised without spawning cdk. */
export interface DestroyRetryDeps {
	/** Run one `cdk destroy` attempt; throws on failure. */
	runDestroy: () => void;
	/** Resolve the app's stacks, by stack name and Region (for bucket enumeration). */
	listStacks: () => AssemblyStack[];
	/** Empty the given stacks' versioned S3 buckets. */
	emptyBuckets: (stacks: AssemblyStack[]) => Promise<void>;
	/** Backoff between retries (VPC-ENI detach, bucket-block clearing, DeleteRestApi 429 throttle). */
	sleep: (ms: number) => Promise<void>;
	/** Backoff between retries. Default: 1min, then 2min. */
	retryDelays?: number[];
	/** What the resource is, for the success log. Default: 'Sandbox' (production passes 'Production stack'). */
	successLabel?: string;
	/**
	 * Whether the attempt that started at `attemptStartedAt` (epoch ms) failed
	 * on an AWS API throttle (e.g. DeleteRestApi 429); `previousFailureAt` is
	 * when the previous attempt failed (events up to then belong to it, not to
	 * this attempt), undefined on the first attempt. A throttled failure is
	 * retried with {@link throttleBackoff} instead of `retryDelays`; a rejection
	 * is logged and treated as "not throttled". Default: never throttled.
	 */
	isThrottled?: (stacks: AssemblyStack[], attemptStartedAt: number, previousFailureAt?: number) => Promise<boolean>;
	/** Backoff for throttled failures. Default: randomized waits of up to 1min, 2min, 4min, then 5min, within 20min of the first failure. */
	throttleBackoff?: ThrottleBackoff;
	/** Jitter source in [0, 1). Default: `Math.random`. */
	random?: () => number;
	/** Clock (epoch ms). Default: `Date.now`. */
	now?: () => number;
	/**
	 * After a failed attempt that started at `attemptStartedAt` (epoch ms), the
	 * Lambda@Edge stacks whose delete failed because CloudFront still
	 * replicates their function (see {@link edgeStacksBlockedByReplicas}). When
	 * there is one, the loop stops and says to run {@link rerunCommand} later,
	 * instead of retrying. Default: not checked.
	 */
	edgeReplicaBlocked?: (stacks: AssemblyStack[], attemptStartedAt: number) => Promise<string[]>;
	/** The command that re-runs this destroy, for the Lambda@Edge hint. Default: 'npm run sandbox:destroy'. */
	rerunCommand?: string;
}

/**
 * Retry `cdk destroy`, clearing the two known teardown blockers before each
 * retry: (1) non-empty versioned S3 buckets — `cdk destroy` relies on each
 * bucket's autoDeleteObjects Lambda, which never provisioned if the CREATE
 * failed, so the bucket blocks the delete and the stack (+ its IAM roles) leaks;
 * we empty them out-of-band — and (2) VPC ENIs that take 60-120s to detach (the
 * backoff). Stack names are resolved once and reused (topology is stable across
 * attempts; an empty list, e.g. after a failed synth, is resolved again).
 * Deterministic auth/account failures never reach here: both callers
 * run an {@link assertAwsCredentials} pre-flight first, so this loop only ever
 * retries a transient teardown blocker. Factored out with injectable deps so
 * this behavior is unit-testable.
 *
 * A failure that `isThrottled` attributes to an AWS API throttle (typically
 * API Gateway's DeleteRestApi quota of one request every 30s per account, hit
 * when several stacks in one account tear down at once) is retried longer:
 * jittered exponential backoff ({@link throttleBackoffDelay}) until
 * `throttleBackoff.budgetMs` after the first failure is spent. Every other
 * failure keeps the `retryDelays` schedule: at most `retryDelays.length`
 * ordinary retries per call, whatever throttled retries came between them,
 * and none once a throttle backoff has used up the budget. A failure counts as
 * throttled when any resource delete in that attempt was throttled, so another
 * resource that failed for a different reason in the same attempt gets the
 * throttle schedule too: it is retried later, not hidden, and still fails the
 * call once the budget is spent. With 5-minute attempts a call can run for
 * about 30 minutes before it fails (about 18 with the ordinary schedule alone).
 *
 * A Lambda@Edge function can only be deleted once CloudFront has removed its
 * replicas, which takes a few hours after its distribution is deleted. So when
 * a failed attempt's Lambda@Edge stack failed on its replicated function,
 * retrying within minutes cannot help (CDK would fail on that stack again and
 * stop there): the loop prints that and tells the user to run
 * {@link DestroyRetryDeps.rerunCommand} again later.
 */
export async function runDestroyWithRetries(deps: DestroyRetryDeps): Promise<void> {
	const retryDelays = deps.retryDelays ?? [60_000, 120_000];
	const label = deps.successLabel ?? 'Sandbox';
	const now = deps.now ?? Date.now;
	const random = deps.random ?? Math.random;
	const isThrottled = deps.isThrottled ?? (async () => false);
	const { budgetMs } = { ...THROTTLE_BACKOFF_DEFAULTS, ...deps.throttleBackoff };
	let stacks: AssemblyStack[] | undefined;
	let firstFailureAt: number | undefined;
	let lastFailureAt: number | undefined;
	let throttleRetries = 0;
	let ordinaryRetries = 0;
	for (let attempt = 0; ; attempt++) {
		const attemptStartedAt = now();
		try {
			deps.runDestroy();
			console.log(attempt === 0 ? `\n✅ ${label} destroyed!` : `\n✅ ${label} destroyed on retry!`);
			return;
		} catch (error) {
			const previousFailureAt = lastFailureAt;
			lastFailureAt = now();
			firstFailureAt ??= lastFailureAt;
			if (!stacks?.length) stacks = deps.listStacks();
			const edgeBlocked = await edgeStacksBlocked(deps, stacks, attemptStartedAt);
			if (edgeBlocked.length > 0) {
				console.error(
					`\n❌ ${edgeBlocked.join(', ')} can't be deleted yet: CloudFront still holds replicas of its Lambda@Edge ` +
						'function, which take a few hours to clear after the distribution is deleted, so retrying now cannot ' +
						`help. Run \`${deps.rerunCommand ?? 'npm run sandbox:destroy'}\` again later; it also deletes any other ` +
						'stack still left.',
				);
				throw error;
			}
			let throttled = false;
			try {
				throttled = await isThrottled(stacks, attemptStartedAt, previousFailureAt);
			} catch (e) {
				console.warn(
					`  ⚠️  could not tell whether the delete was throttled; using the ordinary retry schedule: ${(e as Error).message}`,
				);
			}
			let delayMs: number | undefined;
			const throttleBudgetSpent = throttleRetries > 0 && now() - firstFailureAt > budgetMs;
			if (throttled) {
				const next = throttleBackoffDelay(throttleRetries, deps.throttleBackoff ?? {}, random);
				if (now() - firstFailureAt + next <= budgetMs) delayMs = next;
			} else if (ordinaryRetries < retryDelays.length && !throttleBudgetSpent) {
				delayMs = retryDelays[ordinaryRetries];
			}
			if (delayMs === undefined) {
				console.error('\n❌ Destroy failed after retries.');
				if (throttled) {
					console.error(
						'   The last attempt was throttled by AWS (for example, API Gateway allows one REST API ' +
							'delete every 30s per account). Wait a few minutes and run destroy again; if it fails ' +
							'again, check the stack events for other errors.',
					);
				} else if (ordinaryRetries < retryDelays.length) {
					console.error(
						'   Earlier attempts were throttled by AWS and used up the retry time. Check the stack ' +
							'events for this failure, then run destroy again.',
					);
				}
				throw error;
			}
			if (stacks.length > 0) {
				console.log('\n🧹 Emptying versioned S3 buckets before retry...');
				await deps.emptyBuckets(stacks);
			}
			const delaySec = Math.round(delayMs / 1000);
			if (throttled) {
				throttleRetries++;
				console.log(
					`\n⏳ Stack deletion was throttled by AWS (API rate limit). Retrying in ${delaySec}s ` +
						`(throttle retry ${throttleRetries}; backing off for up to ${Math.round(budgetMs / 60_000)} min)...`,
				);
			} else {
				ordinaryRetries++;
				console.log(`\n⏳ Stack deletion failed. Retrying in ${delaySec}s (waiting for resource cleanup)...`);
			}
			await deps.sleep(delayMs);
		}
	}
}

/** {@link DestroyRetryDeps.edgeReplicaBlocked}, or [] when it is not given, there are no stacks, or it fails. */
async function edgeStacksBlocked(deps: DestroyRetryDeps, stacks: AssemblyStack[], attemptStartedAt: number): Promise<string[]> {
	if (!deps.edgeReplicaBlocked || stacks.length === 0) return [];
	try {
		return await deps.edgeReplicaBlocked(stacks, attemptStartedAt);
	} catch {
		return [];
	}
}

/**
 * Where `sandbox:destroy` has CDK write the assembly it synthesizes (`--output`),
 * relative to the project root. The retry reads the stack list from it. Its own
 * directory, so a production `destroy` running at the same time can't clear it.
 */
const SANDBOX_DESTROY_ASSEMBLY_DIR = '.blocks-sandbox/sandbox-destroy.out';

export async function destroySandbox(backendPath: string) {
  return trackCommand('sandbox:destroy', async () => {
    console.log("🗑️  Destroying sandbox...");

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

/**
 * The {@link runDestroyWithRetries} dependencies `destroySandbox` runs with.
 * A separate function so a test can pin the wiring (throttle detection, bucket
 * emptying, the Lambda@Edge stop) without spawning cdk. `clients` are the AWS
 * clients the retry uses (see {@link destroyRetryClients}).
 */
export function sandboxDestroyDeps(
  backendPath: string,
  cdkEnv: NodeJS.ProcessEnv,
  clients: Required<EmptyBucketsClients>,
): DestroyRetryDeps {
  const cdkArgs = [
    "exec", "cdk", "--", "destroy",
    // `--all`, like the deploy (see buildSandboxDeployArgs): without it CDK
    // refuses an app with more than one stack (a Lambda@Edge
    // `edge-lambda-stack-*` outside us-east-1, a VPC lookup stack), so the
    // destroy can never succeed. CDK deletes dependent stacks first.
    "--all",
    "--force",
    "--output", SANDBOX_DESTROY_ASSEMBLY_DIR,
    // sandboxMode=true is what makes the app name this sandbox's stacks;
    // without it the app names its production stacks, and `--all --force`
    // would delete those. projectRoot matches the sandbox deploy, so both
    // resolve the same stack names.
    "--context", "sandboxMode=true",
    "--context", `projectRoot=${process.cwd()}`,
    // Single-quote backendPath: CDK re-runs the --app string through a shell,
    // so an unquoted path containing a space would split.
    "--app", `npm exec tsx -- -C cdk '${backendPath}'`,
  ];
  return {
    runDestroy: () => runSync('npm', cdkArgs, { stdio: 'inherit', env: cdkEnv }),
    listStacks: () => listDestroyedStacks(SANDBOX_DESTROY_ASSEMBLY_DIR),
    emptyBuckets: (stacks) => emptySandboxBuckets(stacks, clients),
    isThrottled: (stacks, since, previous) => destroyWasThrottled(stacks, since, previous, clients.cfnFor),
    edgeReplicaBlocked: (stacks, since) => edgeStacksBlockedByReplicas(stacks, since, clients.cfnFor),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
