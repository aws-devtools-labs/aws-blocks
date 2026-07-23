// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Annotations } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import {
  CodeBuildStep,
  CodePipeline,
  CodePipelineSource,
  ManualApprovalStep,
  ShellStep,
} from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'node:url';
import { isSecret, resolveSecretsAtSynth, secretStoreLocator } from '@aws-blocks/hosting';
import type {
  BranchConfig,
  PipelineProps,
  PipelineStageConfig,
} from './types.js';
import { __PIPELINE_STAGE_SCOPE__ } from './constants.js';

/**
 * Resolve a relative file path against the calling file's directory.
 *
 * Uses `Error.stack` to locate the first external caller (skipping frames
 * from this module and node_modules). This allows users to write
 * `appFile: './index.cdk.ts'` relative to their pipeline.cdk.ts file
 * rather than relative to `process.cwd()`.
 *
 * @param relativePath - The path to resolve; returned as-is if already absolute.
 * @returns Absolute path resolved against the caller's directory, or CWD as fallback.
 */
function resolveRelativeToCaller(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath;

  const stack = new Error().stack;
  if (stack) {
    const lines = stack.split('\n');
    for (const line of lines.slice(1)) {
      // ESM stack traces use file:// URLs
      const fileUrlMatch = line.match(/file:\/\/(.+?):\d+:\d+/);
      const plainMatch = line.match(/\((.+?):\d+:\d+\)/) || line.match(/at\s+(.+?):\d+:\d+/);

      const filePath = fileUrlMatch
        ? fileUrlMatch[1]
        : plainMatch?.[1];

      if (filePath && !filePath.includes('node_modules') && !filePath.includes('pipeline-construct')) {
        const callerDir = path.dirname(filePath);
        return path.resolve(callerDir, relativePath);
      }
    }
  }

  // Fallback: resolve relative to CWD
  return path.resolve(process.cwd(), relativePath);
}

const VALID_ARN_PATTERN = /^arn:(aws|aws-us-gov|aws-cn):(codeconnections|codestar-connections):[a-z0-9-]+:\d{12}:connection\/[a-zA-Z0-9-]+$/;

const DEFAULT_SYNTH_COMMANDS = ['npm ci', 'npx cdk synth'];

const BAKE_TIMEOUT_BUFFER_MINUTES = 10;

/**
 * Default partial CodeBuild BuildSpec applied to the synth step when
 * `synth.partialBuildSpec` is omitted. Pins the synth runtime to Node.js 22.
 *
 * Hoisted to module scope so the consuming site and tests share a single
 * source of truth. `BuildSpec.fromObject` does not require a construct scope,
 * so it is safe to construct once at module load.
 */
const DEFAULT_SYNTH_PARTIAL_BUILD_SPEC = codebuild.BuildSpec.fromObject({
  phases: { install: { 'runtime-versions': { nodejs: 22 } } },
});

/**
 * CDK Pipelines-based CI/CD pipeline construct (L3).
 *
 * Creates one self-mutating CodePipeline V2 per branch entry. Each pipeline:
 * - Pulls source from GitHub via CodeConnections (OAuth, no tokens)
 * - Runs synth (install + cdk synth)
 * - Self-mutates if the pipeline definition changes
 * - Deploys to ordered stages with optional manual approval and baking time
 *
 * Multiple branches each get their own independent pipeline, named
 * `${id}-${branch}`. This allows different branches to have different
 * stage configurations and deployment topologies.
 *
 * **Sync vs. Async stageFactory:**
 * - Sync factory: use `new Pipeline(scope, id, props)` directly
 * - Async factory (e.g., `BlocksStack.create()`): use `await Pipeline.create(scope, id, props)`
 *
 * @typeParam TConfig - Type of the user-defined `config` object passed to each stage.
 *
 * @example Sync stageFactory
 * ```ts
 * new Pipeline(stack, 'Pipeline', {
 *   source: {
 *     repo: 'my-org/my-app',
 *     connectionArn: 'arn:aws:codeconnections:us-east-1:123456789:connection/abc',
 *   },
 *   branches: [
 *     {
 *       branch: 'main',
 *       stages: [
 *         { name: 'beta' },
 *         { name: 'prod', requireApproval: true, config: { domain: 'myapp.com' } },
 *       ],
 *     },
 *   ],
 *   stageFactory: (scope, stageConfig) => {
 *     new MyAppStack(scope, 'App', { env: stageConfig.env });
 *   },
 * });
 * ```
 *
 * @example Async stageFactory with BlocksStack
 * ```ts
 * await Pipeline.create(stack, 'Pipeline', {
 *   source: { repo: 'my-org/my-app', connectionArn: '...' },
 *   branches: [{ branch: 'main', stages: [{ name: 'prod' }] }],
 *   stageFactory: async (scope, stageConfig) => {
 *     const blocksStack = await BlocksStack.create(scope, 'App', {
 *       backendHandlerPath: './handler.ts',
 *       backendCDKPath: './infra.ts',
 *     });
 *     new Hosting(blocksStack, 'Hosting', { root: '.', buildCommand: 'npm run build', api: blocksStack });
 *   },
 * });
 * ```
 */
export class Pipeline<TConfig = Record<string, unknown>> extends Construct {
  /** The underlying CDK Pipelines CodePipeline instances, keyed by branch name. */
  public readonly codePipelines: ReadonlyMap<string, CodePipeline>;

  /** Internal marker to allow async create() to bypass sync validation. */
  private static readonly _ASYNC_INIT = Symbol('asyncInit');

  /**
   * Create a Pipeline with a synchronous stageFactory.
   *
   * For async stageFactory (e.g., when using `BlocksStack.create()`), use
   * the static `Pipeline.create()` method instead.
   */
  constructor(scope: Construct, id: string, props: PipelineProps<TConfig>, _internal?: { marker: symbol; pipelines: Map<string, CodePipeline> }) {
    super(scope, id);

    if (_internal && _internal.marker === Pipeline._ASYNC_INIT) {
      this.codePipelines = _internal.pipelines;
      return;
    }

    if (scope instanceof cdk.App) {
      throw new Error(
        'Pipeline: sync constructor requires a Stack scope, not an App. ' +
        'Either wrap in a Stack or use Pipeline.create() which auto-wraps.'
      );
    }

    if (props.appFile && !props.stageFactory) {
      throw new Error(
        'Pipeline: `appFile` requires async resolution — use `await Pipeline.create(...)` instead of `new Pipeline(...)`. ' +
        'For the sync constructor, provide a `stageFactory` function.'
      );
    }

    if (!props.stageFactory && !props.appFile) {
      throw new Error('Pipeline: either `stageFactory` or `appFile` must be provided (sync constructor requires an explicit value).');
    }

    if (props.stageFactory && props.stageFactory.constructor.name === 'AsyncFunction') {
      throw new Error('Pipeline: async stageFactory detected in sync constructor. Use the static Pipeline.create() method for async stage factories.');
    }

    validateProps(this, props);

    const pipelines = new Map<string, CodePipeline>();

    for (const branchConfig of props.branches) {
      const pipeline = createBranchPipelineSync(this, id, branchConfig, props);
      pipelines.set(branchConfig.branch, pipeline);
    }

    this.codePipelines = pipelines;
  }

  /**
   * Async factory for Pipelines that use an async stageFactory.
   *
   * Use this when your stageFactory needs to `await` async operations
   * (e.g., `BlocksStack.create()`). The method awaits each stage factory call
   * before proceeding, ensuring all CDK constructs are fully initialized
   * before synthesis.
   *
   * @example
   * ```ts
   * await Pipeline.create(stack, 'Pipeline', {
   *   source: { repo: 'org/app', connectionArn: '...' },
   *   branches: [{ branch: 'main', stages: [{ name: 'prod' }] }],
   *   stageFactory: async (scope, stageConfig) => {
   *     const blocksStack = await BlocksStack.create(scope, 'App', {
   *       backendHandlerPath: './handler.ts',
   *       backendCDKPath: './infra.ts',
   *     });
   *     new Hosting(blocksStack, 'Hosting', { root: '.', buildCommand: 'npm run build', api: blocksStack });
   *   },
   * });
   * ```
   */
  static async create<TConfig = Record<string, unknown>>(
    scope: Construct,
    id: string,
    props: PipelineProps<TConfig>,
  ): Promise<Pipeline<TConfig>> {
    // Default appFile to './index.cdk.ts' when neither stageFactory nor appFile is provided
    const effectiveAppFile = props.appFile ?? (props.stageFactory ? undefined : './index.cdk.ts');

    // Resolve appFile relative to caller BEFORE any async operations (stack trace needs caller frame)
    const resolvedAppFile = effectiveAppFile
      ? resolveRelativeToCaller(effectiveAppFile)
      : undefined;

    if (resolvedAppFile && !fs.existsSync(resolvedAppFile)) {
      throw new Error(
        `Pipeline: resolved appFile path '${resolvedAppFile}' does not exist. ` +
        `Pass an explicit absolute path via the 'appFile' option, e.g.: appFile: join(__dirname, 'index.cdk.ts')`,
      );
    }

    if (resolvedAppFile) {
      validateAppFilePath(resolvedAppFile);
    }

    let actualScope: Construct = scope;
    if (scope instanceof cdk.App) {
      actualScope = new cdk.Stack(scope, id);
    }

    // Resolve a secret() connectionArn at SYNTH time (before validation/use).
    // CodeBuild has no `.env`, so a store-backed secret is the right mechanism.
    const resolvedProps = await resolveSourceSecrets(props);

    // Create the Pipeline instance in async-init mode (skips sync pipeline building)
    const instance = new Pipeline<TConfig>(actualScope, id, resolvedProps, {
      marker: Pipeline._ASYNC_INIT,
      pipelines: new Map(),
    });

    validateProps(instance, resolvedProps);

    const pipelines = new Map<string, CodePipeline>();

    for (const branchConfig of resolvedProps.branches) {
      const pipeline = await createBranchPipelineAsync(instance, id, branchConfig, resolvedProps, resolvedAppFile);
      pipelines.set(branchConfig.branch, pipeline);
    }

    // Assign the resolved pipelines to the instance
    (instance as { codePipelines: ReadonlyMap<string, CodePipeline> }).codePipelines = pipelines;

    return instance;
  }
}

// ─── Shared helpers ──────────────────────────────────────────────

/**
 * Resolve a `secret()` marker on `source.connectionArn` to a plaintext ARN at
 * synth time, returning props with the resolved literal. A plain-string ARN is
 * returned unchanged. Uses the shared hosting resolver (SSM/Secrets Manager),
 * so the pipeline needs no store code of its own.
 */
async function resolveSourceSecrets<TConfig>(props: PipelineProps<TConfig>): Promise<PipelineProps<TConfig>> {
  const arn = props.source.connectionArn;
  if (!isSecret(arn)) return props;

  // Resolve from the SAME namespace/store the caller configured for
  // buildSecrets — otherwise a `secrets: { store, prefix }` config would apply
  // to buildSecrets but silently NOT to a secret() connectionArn.
  const resolved = await resolveSecretsAtSynth([arn.key], {
    prefix: props.secrets?.prefix,
    store: props.secrets?.store,
  });
  const value = resolved.get(arn.key);
  if (value === undefined) {
    throw new Error(`Pipeline: connectionArn secret('${arn.key}') did not resolve.`);
  }
  return { ...props, source: { ...props.source, connectionArn: value } };
}

/**
 * Map `buildSecrets` markers to CodeBuild environment variables that CodeBuild
 * fetches from the store **at build time** (type `SECRETS_MANAGER` or
 * `PARAMETER_STORE`). CodeBuild grants the build role read on each referenced
 * secret and masks the value in build logs; the value never enters the template.
 * Returns `undefined` when there are no build secrets, so the buildEnvironment
 * is left untouched in that case.
 */
function buildSecretEnvVars<TConfig>(
  props: PipelineProps<TConfig>,
): Record<string, codebuild.BuildEnvironmentVariable> | undefined {
  const buildSecrets = props.buildSecrets;
  if (!buildSecrets || Object.keys(buildSecrets).length === 0) return undefined;

  const prefix = props.secrets?.prefix;
  const store = props.secrets?.store;
  const type =
    (store ?? 'secrets-manager') === 'secrets-manager'
      ? codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER
      : codebuild.BuildEnvironmentVariableType.PARAMETER_STORE;

  const envVars: Record<string, codebuild.BuildEnvironmentVariable> = {};
  for (const [name, marker] of Object.entries(buildSecrets)) {
    if (!isSecret(marker)) {
      throw new Error(
        `Pipeline: buildSecrets['${name}'] must be a secret('...') marker. ` +
          'Pass a marker so the value is read from the store at build time, never inlined.',
      );
    }
    // CodeBuild resolves this locator at build time: the SM secret name or the
    // SSM parameter name (secretStoreLocator produces the store-appropriate form).
    envVars[name] = { type, value: secretStoreLocator(marker.key, { prefix, store }) };
  }
  return envVars;
}

function validateProps<TConfig>(construct: Construct, props: PipelineProps<TConfig>): void {
  if (props.stageFactory && props.appFile) {
    throw new Error('Pipeline: `stageFactory` and `appFile` are mutually exclusive. Provide one or the other.');
  }

  if (props.branches.length === 0) {
    throw new Error('Pipeline: `branches` must not be empty.');
  }

  if (!props.source.repo.includes('/')) {
    throw new Error(
      `Pipeline: \`repo\` must be in "owner/repo" format (got "${props.source.repo}").`,
    );
  }

  if (isSecret(props.source.connectionArn)) {
    throw new Error(
      "Pipeline: `connectionArn: secret('...')` resolves at synth time and " +
        'requires the async path — use `await Pipeline.create(scope, id, props)` ' +
        'instead of `new Pipeline(...)`.',
    );
  }

  if (!VALID_ARN_PATTERN.test(props.source.connectionArn)) {
    throw new Error(
      'Pipeline: `connectionArn` must be a valid CodeConnections ARN ' +
      'in the format "arn:aws:codeconnections:<region>:<account-id>:connection/<connection-id>" ' +
      '(legacy "arn:aws:codestar-connections:..." format is also accepted). ' +
      'Accepted partitions: aws, aws-us-gov, aws-cn. ' +
      'Create a CodeConnections connection in the AWS Console under Developer Tools > Connections, ' +
      'then complete the OAuth handshake before using it.',
    );
  }

  const branchNames = new Set<string>();
  for (const branchConfig of props.branches) {
    if (branchNames.has(branchConfig.branch)) {
      throw new Error(
        `Pipeline: duplicate branch name "${branchConfig.branch}". Each branch must be unique.`,
      );
    }
    branchNames.add(branchConfig.branch);

    if (branchConfig.stages.length === 0) {
      throw new Error(
        `Pipeline: branch "${branchConfig.branch}" has an empty \`stages\` array. At least one stage is required.`,
      );
    }

    const stageNames = new Set<string>();
    for (const stage of branchConfig.stages) {
      if (stageNames.has(stage.name)) {
        throw new Error(
          `Pipeline: duplicate stage name "${stage.name}" in branch "${branchConfig.branch}". Stage names must be unique within a branch.`,
        );
      }
      stageNames.add(stage.name);
    }
  }

  const seenBranchIds = new Set<string>();
  for (const branchConfig of props.branches) {
    const safeBranch = branchConfig.branch.replace(/[^a-zA-Z0-9-]/g, '-');
    if (seenBranchIds.has(safeBranch)) {
      throw new Error(
        `Pipeline: branch '${branchConfig.branch}' produces duplicate ID '${safeBranch}'. ` +
        'Ensure branch names are unique after sanitization (only alphanumeric and hyphens are kept).'
      );
    }
    seenBranchIds.add(safeBranch);
  }

  const pipelineAccount = cdk.Stack.of(construct).account;
  const hasCrossAccount = !cdk.Token.isUnresolved(pipelineAccount) && props.branches.some(b =>
    b.stages.some(s => s.env?.account && !cdk.Token.isUnresolved(s.env.account) && s.env.account !== pipelineAccount),
  );
  if (hasCrossAccount && !props.crossAccountKeys) {
    throw new Error(
      'Pipeline: crossAccountKeys must be true when deploying to different accounts. ' +
      'This creates a KMS key (~$1/month) for cross-account artifact encryption.',
    );
  }

  if (props.synth?.computeType === codebuild.ComputeType.SMALL) {
    Annotations.of(construct).addWarning(
      'ComputeType.SMALL (3GB RAM) may be insufficient for apps with Lambda bundling or frontend builds. ' +
      'If synth fails with exit code 137 (OOM), remove the computeType override to use the default MEDIUM (7GB).',
    );
  }
}

/** Allowed file extensions for appFile dynamic imports. */
const ALLOWED_APP_FILE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs']);

/**
 * Validates that the resolved appFile path is safe for dynamic import.
 *
 * Checks:
 * 1. The file extension is an allowed module type (.ts, .js, .mjs, .cjs).
 * 2. The resolved real path is contained within the project root directory,
 *    preventing path traversal attacks (e.g., `../../etc/passwd.ts`).
 *
 * @throws Error if the file extension is not allowed or the path escapes the project root.
 * @internal Exported for testing only.
 */
export function validateAppFilePath(resolvedAppFile: string): void {
  const ext = path.extname(resolvedAppFile).toLowerCase();
  if (!ALLOWED_APP_FILE_EXTENSIONS.has(ext)) {
    throw new Error(
      `Pipeline: appFile must have a module extension (${[...ALLOWED_APP_FILE_EXTENSIONS].join(', ')}). ` +
      `Got '${ext}' in '${resolvedAppFile}'.`,
    );
  }

  const projectRoot = process.cwd();
  const realFilePath = fs.realpathSync(resolvedAppFile);
  const realRoot = fs.realpathSync(projectRoot);

  if (realFilePath !== realRoot && !realFilePath.startsWith(realRoot + path.sep)) {
    throw new Error(
      `Pipeline: appFile must be inside the project root. ` +
      `Resolved path '${realFilePath}' is outside '${realRoot}'.`,
    );
  }
}

function buildCodePipeline<TConfig>(
  construct: Construct,
  branchId: string,
  branchConfig: BranchConfig<TConfig>,
  props: PipelineProps<TConfig>,
): CodePipeline {
  const hasTriggerFilters = props.source.triggerFilters && props.source.triggerFilters.length > 0;
  if (branchConfig.triggerOnPush === true && hasTriggerFilters) {
    throw new Error(`Pipeline branch '${branchConfig.branch}': triggerOnPush cannot be true when triggerFilters are set. CodePipeline uses filters instead of push triggers when filters are configured.`);
  }
  const triggerOnPush = hasTriggerFilters
    ? false
    : (branchConfig.triggerOnPush ?? props.source.triggerOnPush ?? true);

  // connectionArn is resolved to a plain string by resolveSourceSecrets (async
  // path) and rejected as a marker by validateProps (sync path), so by here it
  // is always a string. Guard defensively to satisfy the type + catch misuse.
  const connectionArn = props.source.connectionArn;
  if (isSecret(connectionArn)) {
    throw new Error('Pipeline: unresolved connectionArn secret — use `await Pipeline.create(...)`.');
  }
  const source = props._sourceOverride ?? CodePipelineSource.connection(
    props.source.repo,
    branchConfig.branch,
    {
      connectionArn,
      triggerOnPush,
    },
  );

  const synthCommands = props.synth?.commands ?? DEFAULT_SYNTH_COMMANDS;
  const userNodeOptions = props.synth?.env?.NODE_OPTIONS ?? '';
  const { NODE_OPTIONS: _, ...restUserEnv } = props.synth?.env ?? {};
  const synthEnv = {
    ...restUserEnv,
    NODE_OPTIONS: `--conditions=cdk ${userNodeOptions}`.trim(),
  };
  const synthStep = new ShellStep('Synth', {
    input: source,
    installCommands: props.synth?.installCommands,
    commands: synthCommands,
    env: synthEnv,
    primaryOutputDirectory: props.synth?.primaryOutputDirectory,
  });

  // partialBuildSpec opt-out semantics:
  //   undefined (omitted) -> apply the Node.js 22 default
  //   null                -> opt out entirely (no partialBuildSpec injected; bring your own via installCommands)
  //   a BuildSpec value    -> use it as-is
  const partial = props.synth?.partialBuildSpec === null
    ? undefined
    : (props.synth?.partialBuildSpec ?? DEFAULT_SYNTH_PARTIAL_BUILD_SPEC);

  // buildSecrets → CodeBuild env vars fetched from the store at build time
  // (SECRETS_MANAGER / PARAMETER_STORE). CodeBuild grants read + masks logs.
  const secretEnvVars = buildSecretEnvVars(props);

  return new CodePipeline(construct, branchId, {
    synth: synthStep,
    selfMutation: props.selfMutation ?? true,
    crossAccountKeys: props.crossAccountKeys ?? false,
    pipelineType: codepipeline.PipelineType.V2,
    dockerEnabledForSynth: props.synth?.dockerEnabled ?? false,
    synthCodeBuildDefaults: {
      // Only set partialBuildSpec when defined so the null opt-out leaves the
      // synth buildspec untouched (the field is omitted rather than set to undefined).
      ...(partial ? { partialBuildSpec: partial } : {}),
      buildEnvironment: {
        buildImage: props.synth?.buildImage ?? codebuild.LinuxBuildImage.AMAZON_LINUX_2023_5,
        computeType: props.synth?.computeType ?? codebuild.ComputeType.MEDIUM,
        // Only set environmentVariables when there are build secrets, so the
        // field is omitted (not set to undefined) in the common no-secrets case.
        ...(secretEnvVars ? { environmentVariables: secretEnvVars } : {}),
      },
    },
  });
}

function addStageToCodePipeline<TConfig>(
  codePipeline: CodePipeline,
  stageConfig: PipelineStageConfig<TConfig>,
  deployStage: DeployStage<TConfig>,
): void {
  const pre: Array<ManualApprovalStep | ShellStep> = [];
  const post: Array<ShellStep | CodeBuildStep> = [];

  if (stageConfig.requireApproval) {
    pre.push(new ManualApprovalStep(`Approve-${stageConfig.name}`, {
      comment: stageConfig.approvalComment ?? `Approve deployment to ${stageConfig.name}`,
    }));
  }

  if (stageConfig.bakeTime) {
    const seconds = stageConfig.bakeTime.toSeconds();
    post.push(new CodeBuildStep(`BakeTime-${stageConfig.name}`, {
      commands: [`echo "Baking for ${seconds}s..." && sleep ${seconds}`],
      buildEnvironment: { computeType: codebuild.ComputeType.SMALL },
      timeout: cdk.Duration.minutes(stageConfig.bakeTime.toMinutes() + BAKE_TIMEOUT_BUFFER_MINUTES),
    }));
  }

  codePipeline.addStage(deployStage, { pre, post });
}

function validateBakeTime<TConfig>(stageConfig: PipelineStageConfig<TConfig>): void {
  if (stageConfig.bakeTime && stageConfig.bakeTime.toMinutes() <= 0) {
    throw new Error(`Pipeline: bakeTime for stage '${stageConfig.name}' must be positive.`);
  }
}

function validateStageName<TConfig>(stageConfig: PipelineStageConfig<TConfig>): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(stageConfig.name)) {
    throw new Error(
      `Pipeline: stage name '${stageConfig.name}' contains invalid characters. ` +
      'Use only letters, numbers, hyphens, and underscores.'
    );
  }
}

function validateStageStacks(stage: cdk.Stage, stageName: string, source: 'stageFactory' | 'appFile'): void {
  const stacks = stage.node.children.filter(
    (c): c is cdk.Stack => c instanceof cdk.Stack,
  );

  if (stacks.length === 0) {
    const hint = source === 'appFile'
      ? 'When using `appFile`, ensure your CDK app creates stacks via `BlocksStack.create()` ' +
        '(which uses the ambient pipeline scope) or create stacks directly on the stage scope.'
      : 'Ensure `stageFactory` creates at least one Stack on the provided scope.';

    throw new Error(
      `Pipeline: stage '${stageName}' contains no stacks after running ${source}. ` +
      `CDK Pipelines requires at least one Stack in each stage to generate deploy actions. ${hint}`,
    );
  }
}

// ─── Sync path ───────────────────────────────────────────────────

function createBranchPipelineSync<TConfig>(
  construct: Construct,
  id: string,
  branchConfig: BranchConfig<TConfig>,
  props: PipelineProps<TConfig>,
): CodePipeline {
  const safeBranch = branchConfig.branch.replace(/[^a-zA-Z0-9-]/g, '-');
  const branchId = `${id}-${safeBranch}`;

  const codePipeline = buildCodePipeline(construct, branchId, branchConfig, props);

  for (const stageConfig of branchConfig.stages) {
    validateBakeTime(stageConfig);
    validateStageName(stageConfig);

    const stage = new DeployStage(construct, `${branchId}-Stage-${stageConfig.name}`, {
      stageConfig,
    });
    const result = props.stageFactory!(stage, stageConfig);
    if (result && typeof (result as any).then === 'function') {
      throw new Error(
        'Pipeline: stageFactory returned a Promise. ' +
        'Use Pipeline.create() for async stage factories.',
      );
    }
    validateStageStacks(stage, stageConfig.name, 'stageFactory');
    addStageToCodePipeline(codePipeline, stageConfig, stage);
  }

  addTriggerFilters(codePipeline, branchConfig, props);

  return codePipeline;
}

// ─── Async path ──────────────────────────────────────────────────

async function createBranchPipelineAsync<TConfig>(
  construct: Construct,
  id: string,
  branchConfig: BranchConfig<TConfig>,
  props: PipelineProps<TConfig>,
  resolvedAppFile?: string,
): Promise<CodePipeline> {
  const safeBranch = branchConfig.branch.replace(/[^a-zA-Z0-9-]/g, '-');
  const branchId = `${id}-${safeBranch}`;

  const codePipeline = buildCodePipeline(construct, branchId, branchConfig, props);

  for (const stageConfig of branchConfig.stages) {
    validateBakeTime(stageConfig);
    validateStageName(stageConfig);

    const stage = new DeployStage(construct, `${branchId}-Stage-${stageConfig.name}`, {
      stageConfig,
    });

    if (resolvedAppFile) {
      await importAppFileForStage(stage, stageConfig, resolvedAppFile);
    } else {
      await props.stageFactory!(stage, stageConfig);
    }

    validateStageStacks(stage, stageConfig.name, resolvedAppFile ? 'appFile' : 'stageFactory');
    addStageToCodePipeline(codePipeline, stageConfig, stage);
  }

  addTriggerFilters(codePipeline, branchConfig, props);

  return codePipeline;
}

// ─── appFile import helper ───────────────────────────────────────

async function importAppFileForStage<TConfig>(
  stage: cdk.Stage,
  stageConfig: PipelineStageConfig<TConfig>,
  appFile: string,
): Promise<void> {
  const stageEnv = stageConfig.environment;
  const savedEnv: Record<string, string | undefined> = {};

  // Set stage-specific env vars on process.env
  if (stageEnv) {
    for (const [key, value] of Object.entries(stageEnv)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
  }

  // Set ambient scope for BlocksStack.create() to pick up
  (globalThis as any)[__PIPELINE_STAGE_SCOPE__] = stage;

  // Capture current beforeExit listeners before import
  const listenersBefore = process.listeners('beforeExit').slice();

  try {
    // file:// URL (not a raw path) so the cache-busting query works on Windows.
    const appUrl = pathToFileURL(appFile);
    appUrl.searchParams.set('stage', stageConfig.name);
    await import(appUrl.href);
  } finally {
    // Remove any beforeExit listeners added during import.
    // The imported file's cdk.App() registers a synth() handler that would
    // overwrite cdk.out with an empty manifest since its stacks were
    // redirected to the pipeline's stage scope via the ambient scope.
    const listenersAfter = process.listeners('beforeExit');
    for (const listener of listenersAfter) {
      if (!listenersBefore.includes(listener)) {
        process.removeListener('beforeExit', listener as (...args: any[]) => void);
      }
    }

    // Clean up ambient scope
    delete (globalThis as any)[__PIPELINE_STAGE_SCOPE__];

    // Restore process.env
    if (stageEnv) {
      for (const key of Object.keys(stageEnv)) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    }
  }
}

function addTriggerFilters<TConfig>(
  codePipeline: CodePipeline,
  branchConfig: BranchConfig<TConfig>,
  props: PipelineProps<TConfig>,
): void {
  const triggerFilters = props.source.triggerFilters;
  if (!triggerFilters || triggerFilters.length === 0) {
    return;
  }

  // buildPipeline() MUST be called after all stages are added.
  // It finalizes the pipeline structure and is required before adding V2 triggers.
  codePipeline.buildPipeline();

  const sourceAction = codePipeline.pipeline.stages[0].actions[0];
  codePipeline.pipeline.addTrigger({
    providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
    gitConfiguration: {
      sourceAction,
      pushFilter: [{
        branchesIncludes: [branchConfig.branch],
        filePathsIncludes: triggerFilters,
      }],
    },
  });
}

// ─── DeployStage ─────────────────────────────────────────────────

/**
 * Props for the {@link DeployStage} construct.
 */
export interface DeployStageProps<TConfig = Record<string, unknown>> extends cdk.StageProps {
  /** The stage configuration (name, env, config, etc.). */
  readonly stageConfig: PipelineStageConfig<TConfig>;
}

/**
 * A CDK Stage used by Pipeline to represent a deployment environment.
 *
 * The stageFactory populates this Stage with stacks externally (not in
 * the constructor), allowing both sync and async factory patterns.
 */
export class DeployStage<TConfig = Record<string, unknown>> extends cdk.Stage {
  public readonly stageConfig: PipelineStageConfig<TConfig>;

  constructor(scope: Construct, id: string, props: DeployStageProps<TConfig>) {
    super(scope, id, { env: props.stageConfig.env });
    this.stageConfig = props.stageConfig;
  }
}
