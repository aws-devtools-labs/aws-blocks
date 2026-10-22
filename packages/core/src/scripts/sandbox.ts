// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureSecrets, loadEnvFile } from './ensure-secrets.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { resolveDeploymentTarget } from './deployment-target.js';
import { applyExternalMigrations } from './external-migrations-step.js';
import { trackCommand } from '../telemetry/trackCommand.js';
import { buildAndSendEvent } from '../telemetry/client.js';
import { classifyError } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv, getFrameworkSinkEnv } from './cdk-telemetry-env.js';
import { createFrameworkSink, registerFrameworkFromSink } from '../telemetry/framework-sink.js';
import { formatDeploySignal, selectAppStack } from './deploy-stream.js';
import { runSync, spawnCommand } from './run-command.js';
import { terminateProcessTree } from './process-tree.js';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import type { S3Client } from '@aws-sdk/client-s3';

/**
 * Import the backend definition to populate the Scope BB registry.
 *
 * All BB variants set bbName/bbVersion on construction, so importing the
 * backend is sufficient to register every block. `buildAndSendEvent` then
 * reads the registry internally — callers don't need to pass block data.
 * Failures are silently swallowed — telemetry is best-effort.
 */
async function importBackendForRegistry(backendPath: string): Promise<void> {
  try {
    await import(pathToFileURL(resolve(backendPath)).href);
  } catch {
    // best-effort — telemetry never affects the command
  }
}

export interface SandboxOptions {
  backendPath: string;
  outDir?: string;
  clientPort?: number;
  deployOnly?: boolean;
  /** Custom dev server command. Defaults to 'npx vite'. For Next.js use 'npx next dev'. */
  devCommand?: string;
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
    "--outputs-file", `${outDir}/outputs.json`,
    "--context", `projectRoot=${projectRoot}`,
    "--context", "sandboxMode=true",
    "--app", assemblyDir ?? `npm exec tsx -- -C cdk ${backendPath}`,
  ];
}

/**
 * Build the `npx cdk watch ...` argv the sandbox loop runs after the first deploy.
 *
 * Kept pure (no I/O) so the argv contract can be asserted directly, like
 * {@link buildSandboxDeployArgs}.
 *
 * - `stacks`: the stacks to watch, by construct path, placed right after
 *   `watch`. The sandbox passes the top-level stacks of the assembly it just
 *   deployed with `--all` (see {@link topLevelStackPaths}), so watch redeploys
 *   the same set. Without a selector, `cdk watch` on an app with more than one
 *   stack never deploys and prints no error. `--all` is not a declared option
 *   of `cdk watch` (the CLI warns about it as unknown), and the `*` wildcard
 *   misses a top-level stack whose construct path contains a `/`, so the
 *   stacks are named exactly. An empty list passes no selector (CDK then
 *   watches the app's only stack).
 */
export function buildSandboxWatchArgs({
  outDir,
  projectRoot,
  backendPath,
  stacks,
}: Pick<SandboxDeployArgsOptions, 'outDir' | 'projectRoot' | 'backendPath'> & { stacks: readonly string[] }): string[] {
  return [
    "cdk", "watch",
    ...stacks,
    `--outputs-file`, `${outDir}/outputs.json`,
    `--context`, `projectRoot=${projectRoot}`,
    `--context`, `sandboxMode=true`,
    `--app`, `npm exec tsx -- -C cdk ${backendPath}`
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
  const { backendPath, outDir = ".blocks-sandbox", clientPort = 3000, deployOnly = false, devCommand } = options;
  const sandboxStartTime = Date.now();

  // Load .env.local so CDK can read secret ARNs and other config.
  try { loadEnvFile('.env.local'); } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }

  process.env.BLOCKS_STAGE = 'sandbox';

  // Fail fast if AWS credentials are missing/expired, before spending ~10s in
  // synth only to hit an opaque CDK credential error. Unlike deploy(), startSandbox
  // isn't wrapped in trackCommand, so emit the FAIL event manually (mirroring the
  // CDK-deploy failure path below) before rethrowing — otherwise a no-creds abort
  // sends no telemetry.
  try {
    await assertAwsCredentials({ command: 'sandbox', projectRoot: process.cwd() });
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

  // Import backend to populate Scope BB registry (for telemetry).
  // Runs before CDK deploy so both success and failure paths include block info.
  await importBackendForRegistry(backendPath);

  // Framework resolves in the cdk synth child; it writes the value here so the
  // parent can attach it to the sandbox telemetry event.
  const frameworkSink = createFrameworkSink();
  console.log("🚀 Deploying to AWS...");
  console.log("   (This may take a few minutes on first deploy)");

  const cdkEnv = buildSandboxCdkEnv(frameworkSink);
  const argOptions = { outDir, projectRoot: process.cwd(), backendPath };
  const assemblyDir = `${outDir}/cdk.out`;

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

    runSync(
      "npm",
      // Argv (including sandbox-only CloudFormation Express Mode, `--express`)
      // is built by buildSandboxDeployArgs — see its doc for why each flag exists.
      buildSandboxDeployArgs({ ...argOptions, express: expressUnsafe.length === 0, assemblyDir }),
      { stdio: "inherit", env: cdkEnv },
    );
  } catch (error) {
    registerFrameworkFromSink(frameworkSink);
    buildAndSendEvent({
      command: 'sandbox',
      state: 'FAIL',
      duration: Date.now() - sandboxStartTime,
      error: { code: 'CDK_DEPLOY_FAILED', phase: 'deploy' },
    });
    console.error("\n❌ Deployment failed.");
    console.error(sandboxFailureRecoveryHint());
    throw error;
  }

  registerFrameworkFromSink(frameworkSink);

  const outputs = JSON.parse(readFileSync(`${outDir}/outputs.json`, "utf-8"));
  const stackOutputs = selectAppStack(outputs).outputs;

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

  // Generate client code targeting AWS (aws-runtime condition ensures
  // the backend registers aws-middleware, not mock-middleware).
  const backendDefPath = resolve(join(dirname(resolve(backendPath)), 'index.ts'));
  const clientPath = join(dirname(backendDefPath), 'client.js');
  console.log('📝 Generating client code...');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const workerPath = join(__dirname, 'generate-client-worker.js');
  execFileSync('node', ['--conditions=aws-runtime', '--import', 'tsx', workerPath, backendDefPath, clientPath], {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '' },
  });

  if (deployOnly) {
    return apiUrl;
  }

  console.log("\n👀 Starting CDK watch mode...");
  console.log("🌐 Starting local dev server (proxying to AWS)...");
  console.log(`\n   Open http://localhost:${clientPort}\n`);

  const cdkWatch = spawnCommand("npx", buildSandboxWatchArgs({
    outDir,
    projectRoot: process.cwd(),
    backendPath,
    stacks: topLevelStackPaths(assemblyDir),
  }), {
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group on POSIX so cleanup can reap the whole `cdk watch` tree
    // (npx → cdk → node) via terminateProcessTree, not just the npx shell — a
    // bare kill() would orphan the real cdk-watch node process, the same
    // shell-only-kill leak this PR eliminates for the dev server. Windows has no
    // groups; terminateProcessTree reaps the tree via taskkill.
    detached: process.platform !== 'win32',
    env: { ...process.env, NODE_OPTIONS: "--conditions=cdk", ...getCdkTelemetryEnv('sandbox') },
  });

  cdkWatch.stdout?.on("data", (data) => {
    const str = data.toString().trim();
    if (!str.match(/\[(START|END|REPORT|INIT_START)\s+RequestId:/)) {
      console.log(`[CDK Watch] ${str}`);
    }
  });
  cdkWatch.stderr?.on("data", (data) => {
    console.error(`[CDK Watch] ${data.toString().trim()}`);
  });

  const devServerCmd = devCommand || `npx tsx watch aws-blocks/scripts/server.ts`;
  const [cmd, ...args] = devServerCmd.split(' ');
  
  const devServer = spawnCommand(cmd, args, {
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
 * The construct paths of the top-level stacks in the synthesized assembly at
 * `assemblyDir`: the stacks `cdk deploy --all` selects, as CDK stack patterns
 * (a stack's pattern is its construct path). Stacks inside a CDK `Stage` live
 * in a nested assembly and are not listed. [] if the assembly can't be read.
 */
export function topLevelStackPaths(assemblyDir: string): string[] {
	type Artifact = { type?: string; displayName?: string };
	try {
		const { artifacts = {} } = JSON.parse(readFileSync(join(assemblyDir, 'manifest.json'), 'utf-8')) as {
			artifacts?: Record<string, Artifact>;
		};
		return Object.entries(artifacts)
			.filter(([, artifact]) => artifact.type === 'aws:cloudformation:stack')
			.map(([id, artifact]) => artifact.displayName ?? id);
	} catch {
		return [];
	}
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
		console.warn(`  ⚠️  could not read the synthesized stacks in ${assemblyDir}; skipping bucket-emptying`);
	}
	return stacks;
}

/** Clock skew allowed between this machine and CloudFormation timestamps. */
const EVENT_CLOCK_SKEW_MS = 60_000;

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
	let stacks: AssemblyStack[] | undefined;
	for (let attempt = 0; ; attempt++) {
		const attemptStartedAt = Date.now();
		try {
			deps.runDestroy();
			console.log(attempt === 0 ? `\n✅ ${label} destroyed!` : `\n✅ ${label} destroyed on retry!`);
			return;
		} catch (error) {
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
			if (attempt < retryDelays.length) {
				if (stacks.length > 0) {
					console.log('\n🧹 Emptying versioned S3 buckets before retry...');
					await deps.emptyBuckets(stacks);
				}
				const delaySec = retryDelays[attempt] / 1000;
				console.log(`\n⏳ Stack deletion failed. Retrying in ${delaySec}s (waiting for resource cleanup)...`);
				await deps.sleep(retryDelays[attempt]);
			} else {
				console.error('\n❌ Destroy failed after retries.');
				throw error;
			}
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
    await assertAwsCredentials({ command: 'sandbox:destroy', projectRoot: process.cwd() });

    // Load .env.local so CDK synth can read project refs and other config.
    try { loadEnvFile('.env.local'); } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }

    // The destroy synthesizes into this directory; the retry reads the stacks
    // it selected from there. Cleared first so a failed synth can't leave an
    // earlier run's stack list behind.
    const assemblyDir = SANDBOX_DESTROY_ASSEMBLY_DIR;
    rmSync(assemblyDir, { recursive: true, force: true });
    const cdkArgs = [
      "exec", "cdk", "--", "destroy",
      // `--all`, like the deploy (see buildSandboxDeployArgs): without it CDK
      // refuses an app with more than one stack (a Lambda@Edge
      // `edge-lambda-stack-*` outside us-east-1, a VPC lookup stack), so the
      // destroy can never succeed. CDK deletes dependent stacks first.
      "--all",
      "--force",
      "--output", assemblyDir,
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
    const cdkEnv = { ...process.env, NODE_OPTIONS: "--conditions=cdk", ...getCdkTelemetryEnv('sandbox') };
    const clients = await destroyRetryClients(process.cwd());
    await runDestroyWithRetries({
      runDestroy: () => runSync('npm', cdkArgs, { stdio: 'inherit', env: cdkEnv }),
      listStacks: () => listDestroyedStacks(assemblyDir),
      emptyBuckets: (stacks) => emptySandboxBuckets(stacks, clients),
      edgeReplicaBlocked: (stacks, since) => edgeStacksBlockedByReplicas(stacks, since, clients.cfnFor),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    rmSync(assemblyDir, { recursive: true, force: true });
  });
}
