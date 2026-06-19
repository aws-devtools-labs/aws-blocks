// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as cdk from 'aws-cdk-lib';
import type * as codebuild from 'aws-cdk-lib/aws-codebuild';
import type { IFileSetProducer } from 'aws-cdk-lib/pipelines';

/**
 * Configuration for the pipeline source (GitHub/CodeConnections).
 *
 * Uses AWS CodeConnections (formerly CodeStar Connections) for OAuth-based
 * access to GitHub repositories. No token management required — the
 * connection is created once via the AWS Console.
 */
export interface PipelineSourceConfig {
  /**
   * Repository in `owner/repo` format.
   *
   * @example 'my-org/my-app'
   */
  readonly repo: string;

  /**
   * ARN of the AWS CodeConnections connection.
   *
   * **Important:** This connection requires a one-time OAuth handshake via the
   * AWS Console before it can be used. After creating the connection resource
   * (via CDK, CLI, or Console), you must complete the OAuth flow in the
   * Console under **Developer Tools → Connections** — the connection will be
   * in `PENDING` status until authorized.
   *
   * Steps:
   * 1. Create the connection (Console or CLI)
   * 2. Navigate to **Developer Tools → Connections** in the AWS Console
   * 3. Select the pending connection and click "Update pending connection"
   * 4. Authorize the GitHub app and select your repository/organization
   * 5. The status changes to `AVAILABLE` — the pipeline can now pull source
   *
   * @see https://docs.aws.amazon.com/dtconsole/latest/userguide/connections-create-github.html
   *
   * @example 'arn:aws:codeconnections:us-east-1:123456789:connection/abc-def'
   */
  readonly connectionArn: string;

  /**
   * Whether to trigger the pipeline on push to the branch.
   *
   * @default true
   */
  readonly triggerOnPush?: boolean;

  /**
   * Path-based trigger filters for monorepo support.
   *
   * When specified, the pipeline only triggers on pushes that modify files
   * matching these path patterns. Useful for monorepos where multiple
   * pipelines share a single repository.
   *
   * @example ['packages/backend/**', 'shared/**']
   */
  readonly triggerFilters?: string[];
}

/**
 * Configuration for the synth step (build + CDK synth).
 *
 * The synth step installs dependencies and runs `cdk synth` to produce
 * the CloudFormation template. The pipeline is self-mutating: if the
 * synth output changes the pipeline definition, it updates itself first.
 */
export interface PipelineSynthConfig {
  /**
   * Shell commands to run during the synth step.
   *
   * @default ['npm ci', 'npx cdk synth'] — installs dependencies and synthesizes the CDK app.
   * Override if you need Node version upgrades, custom build steps, or a non-standard cdk.json app path.
   * If your app requires Node 22+, prepend `'n 22'` to commands or use {@link installCommands}.
   */
  readonly commands?: string[];

  /**
   * Commands to run in the CodeBuild install phase (before synth commands).
   *
   * @default [] — no install commands. The default build image (Amazon Linux 2023 standard:5.0)
   * includes Node 22. Set this if you need additional global tools or a different Node version.
   *
   * @example ['n 20'] — downgrade Node to version 20
   */
  readonly installCommands?: string[];

  /**
   * The CodeBuild build image to use for the synth step.
   *
   * The default image (Amazon Linux 2023 standard:5.0) includes Node 22 and
   * Amazon Linux 2023. Override this if you need a different OS or runtime set.
   *
   * @default codebuild.LinuxBuildImage.AMAZON_LINUX_2023_5
   */
  readonly buildImage?: codebuild.IBuildImage;

  /**
   * Environment variables available during synth.
   *
   * Note: `NODE_OPTIONS` is automatically prepended with `--conditions=cdk`
   * (required for ESM conditional exports). Your custom NODE_OPTIONS will be
   * appended after this flag.
   */
  readonly env?: Record<string, string>;

  /**
   * Primary output directory for the CDK cloud assembly.
   *
   * Override this for monorepos where `cdk synth` outputs to a
   * subdirectory (e.g., `packages/infra/cdk.out`).
   *
   * @default 'cdk.out'
   */
  readonly primaryOutputDirectory?: string;

  /**
   * Whether to enable Docker for the synth step.
   *
   * Required when your CDK app uses Docker image assets (e.g., Lambda
   * container images, ECS task definitions with Dockerfile builds).
   *
   * @default false
   */
  readonly dockerEnabled?: boolean;

  /**
   * CodeBuild compute type for the synth step.
   *
   * Controls the CPU/memory allocation for the build environment.
   * Increase this if you encounter OOM (exit code 137) during synth/bundling.
   *
   * - `SMALL`: 2 vCPU, 3 GB
   * - `MEDIUM`: 4 vCPU, 7 GB
   * - `LARGE`: 8 vCPU, 15 GB
   *
   * @default ComputeType.MEDIUM (7GB RAM, 4 vCPU) — sufficient for most apps with
   * Lambda bundling + frontend builds. Use SMALL for trivial apps or LARGE for monorepos.
   */
  readonly computeType?: codebuild.ComputeType;

  /**
   * A partial CodeBuild BuildSpec merged into the synth step's generated buildspec.
   *
   * Use this to control the synth runtime declaratively, most commonly to pin
   * the Node.js version via `runtime-versions`. It merges with (does not replace)
   * the install/build commands generated from {@link installCommands} and
   * {@link commands}, and is orthogonal to the `NODE_OPTIONS` environment variable
   * injection (one configures the buildspec, the other sets an env var).
   *
   * Three behaviors, selected by the value you pass:
   * - **omitted** (`undefined`): the synth step gets a default BuildSpec pinning
   *   the Node.js 22 runtime (see `@default` below). This is the recommended path.
   * - **`null`**: explicit opt-out. No `partialBuildSpec` is injected at all, so
   *   the synth buildspec carries no `runtime-versions` block. Use this when you
   *   want to control the runtime yourself, for example by installing a Node
   *   version via {@link installCommands} (such as `['n 20']`) or by relying on
   *   the build image's built-in runtime without any merged buildspec.
   * - **a `BuildSpec`**: used as-is, replacing the Node.js 22 default.
   *
   * @default a BuildSpec declaring the Node.js 22 runtime:
   * `BuildSpec.fromObject({ phases: { install: { 'runtime-versions': { nodejs: 22 } } } })`.
   * Override with a BuildSpec to select a different runtime or add other
   * buildspec-only settings, or pass `null` to disable the default entirely.
   *
   * @example Pin Node.js 20
   * ```ts
   * synth: {
   *   partialBuildSpec: BuildSpec.fromObject({
   *     phases: { install: { 'runtime-versions': { nodejs: 20 } } },
   *   }),
   * }
   * ```
   *
   * @example Opt out of the Node.js 22 default (bring your own runtime)
   * ```ts
   * synth: {
   *   partialBuildSpec: null,
   *   installCommands: ['n 20'], // or rely on the build image's default runtime
   * }
   * ```
   */
  readonly partialBuildSpec?: codebuild.BuildSpec | null;
}

/**
 * Configuration for a deployment stage.
 *
 * Each stage represents a deployment environment (e.g., beta, prod).
 * Stages are deployed in the order they appear in the `stages` array.
 */
export interface PipelineStageConfig<TConfig = Record<string, unknown>> {
  /**
   * Logical name for this stage (e.g., 'beta', 'prod').
   * Used as the CDK Stage construct id.
   */
  readonly name: string;

  /**
   * Target AWS account and region for this stage.
   * When omitted, deploys to the pipeline's own account/region.
   */
  readonly env?: cdk.Environment;

  /**
   * Whether to require manual approval before deploying to this stage.
   *
   * @default false
   */
  readonly requireApproval?: boolean;

  /**
   * Optional comment shown in the approval notification.
   * Only relevant when `requireApproval` is true.
   */
  readonly approvalComment?: string;

  /**
   * Optional baking time after deployment before proceeding.
   * Useful for canary validation — gives time for alarms to fire.
   *
   * Implemented as a CodeBuild `sleep` step (~$0.005/min on
   * `BUILD_GENERAL1_SMALL`). An explicit timeout of bakeTime + 10 minutes
   * is set on the CodeBuild step to prevent pipeline hangs.
   *
   * For longer baking periods, use `requireApproval: true` with
   * external monitoring/alerting instead.
   */
  readonly bakeTime?: cdk.Duration;

  /**
   * User-defined configuration passed through to the `stageFactory`.
   *
   * Use this for per-stage settings like domain names, feature flags,
   * scaling parameters, etc.
   *
   * @example { domain: 'myapp.com', enableCanary: true }
   */
  readonly config?: TConfig;

  /**
   * Environment variables to set on `process.env` when importing the app file for this stage.
   *
   * These are synthesis-time variables (available during `cdk synth`), not deployment-time.
   * Use this for per-stage configuration that your CDK app reads from `process.env`
   * (e.g., domain names, feature flags). Only applies when using the `appFile` prop.
   *
   * @example { DOMAIN: 'myapp.com', ENABLE_CANARY: 'true' }
   */
  readonly environment?: Record<string, string>;
}

/**
 * Configuration for a single branch pipeline.
 *
 * Each branch entry creates its own independent CodePipeline that triggers
 * on pushes to the specified branch and deploys through its own ordered stages.
 */
export interface BranchConfig<TConfig = Record<string, unknown>> {
  /**
   * Git branch that triggers this pipeline.
   *
   * @example 'main'
   */
  readonly branch: string;

  /**
   * Ordered list of deployment stages for this branch's pipeline.
   */
  readonly stages: Array<PipelineStageConfig<TConfig>>;

  /**
   * Whether to trigger this branch's pipeline on push.
   *
   * Overrides the top-level `source.triggerOnPush` for this specific branch.
   * Useful when you want most branches to auto-trigger but disable it for
   * specific branches (e.g., a release branch that deploys on manual trigger only).
   *
   * @default inherits from source.triggerOnPush (which defaults to true)
   */
  readonly triggerOnPush?: boolean;
}

/**
 * Props for the {@link Pipeline} L3 construct.
 *
 * @example Multi-branch configuration
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
 *     {
 *       branch: 'develop',
 *       stages: [
 *         { name: 'alpha', config: { domain: 'alpha.myapp.com' } },
 *       ],
 *     },
 *   ],
 *   stageFactory: (scope, stageConfig) => {
 *     new MyAppStack(scope, 'App', {
 *       stackName: `my-app-${stageConfig.name}`,
 *       env: stageConfig.env,
 *     });
 *   },
 * });
 * ```
 *
 * @example With custom synth and bake time
 * ```ts
 * new Pipeline(stack, 'Pipeline', {
 *   source: {
 *     repo: 'my-org/my-app',
 *     connectionArn: 'arn:aws:codeconnections:...',
 *   },
 *   branches: [
 *     {
 *       branch: 'release',
 *       stages: [
 *         { name: 'beta' },
 *         { name: 'prod', requireApproval: true, bakeTime: Duration.minutes(30) },
 *       ],
 *     },
 *   ],
 *   synth: {
 *     commands: ['npm ci', 'npm run build', 'npx cdk synth'],
 *   },
 *   stageFactory: (scope, stageConfig) => {
 *     new MyAppStack(scope, 'App', { env: stageConfig.env });
 *   },
 * });
 * ```
 */
export interface PipelineProps<TConfig = Record<string, unknown>> {
  /** Source repository configuration. */
  readonly source: PipelineSourceConfig;

  /** Synth step configuration. */
  readonly synth?: PipelineSynthConfig;

  /**
   * Branch configurations. Each entry creates a separate CodePipeline.
   *
   * A single source repository can have multiple branch pipelines, each
   * with its own set of deployment stages and configuration.
   */
  readonly branches: Array<BranchConfig<TConfig>>;

  /**
   * Factory function that populates a CDK Stage with stacks.
   *
   * Called once per stage across all branches. The factory receives the Stage
   * scope and the full stage configuration object (including `name`, `env`,
   * and any user-defined `config`).
   *
   * May be async when using constructs that require async initialization
   * (e.g., `BlocksStack.create()`). When async, use `Pipeline.create()` instead
   * of `new Pipeline()` to ensure all stages are fully resolved before synth.
   *
   * Mutually exclusive with `appFile`. One of `stageFactory` or `appFile` must be provided
   * for the sync constructor (`new Pipeline()`). When using `Pipeline.create()`, if neither
   * is provided, `appFile` defaults to `'./index.cdk.ts'`.
   *
   * @param scope - The CDK Stage construct to add stacks to.
   * @param stageConfig - The full stage configuration including name, env, and user-defined config.
   */
  readonly stageFactory?: (
    scope: cdk.Stage,
    stageConfig: PipelineStageConfig<TConfig>,
  ) => void | Promise<void>;

  /**
   * Path to the CDK app file to import for each stage.
   *
   * When provided, the pipeline will dynamically import this file once per stage,
   * with the ambient `__PIPELINE_STAGE_SCOPE__` set on globalThis so that
   * `BlocksStack.create()` automatically attaches to the correct stage scope.
   *
   * The path is resolved **relative to the calling file** (not CWD), using
   * `Error.stack` to determine the caller's directory. Absolute paths are
   * used as-is.
   *
   * Each stage's `environment` vars are set on `process.env` before the import
   * and cleaned up afterward.
   *
   * Mutually exclusive with `stageFactory`. When using `Pipeline.create()` and
   * neither `appFile` nor `stageFactory` is provided, defaults to `'./index.cdk.ts'`
   * (resolved relative to the calling file).
   *
   * **Security:** This path is dynamically imported during CDK synth, executing
   * the module's code in the synth process. It MUST originate from a trusted source
   * (developer's pipeline definition file). Never wire this from external input
   * (environment variables, build args, plugin configs, or user-supplied values).
   * A path-containment check enforces that the resolved file stays within the
   * project root, and only `.ts`, `.js`, `.mjs`, `.cjs` extensions are accepted.
   *
   * @default './index.cdk.ts' (when using Pipeline.create() without stageFactory)
   * @example './infra/app.ts'
   */
  readonly appFile?: string;

  /**
   * Whether the pipeline should self-mutate (update its own definition).
   *
   * @default true
   */
  readonly selfMutation?: boolean;

  /**
   * Cross-account keys for artifact encryption.
   * Enable when deploying to accounts different from the pipeline account.
   *
   * @default false
   */
  readonly crossAccountKeys?: boolean;

  /**
   * Substitute the pipeline source with an alternative file-set producer.
   *
   * When provided, this replaces the GitHub/CodeConnections source created from
   * {@link source} as the input to the synth step. This exists so the pipeline
   * can be deployed and exercised in tests without a live GitHub CodeConnections
   * OAuth handshake (for example, by substituting an S3 source).
   *
   * `source` (repo + connectionArn) is still required and validated even when
   * this override is set, so production configs remain well-formed.
   *
   * @internal Not part of the public API. Intended for testing only; the shape
   * and behavior may change without a major version bump.
   */
  readonly _sourceOverride?: IFileSetProducer;
}
