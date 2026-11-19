# @aws-cdk-blocks/pipeline

CDK Pipelines-based CI/CD construct for AWS CDK Blocks applications.

Creates one self-mutating CodePipeline V2 per branch. Each pipeline:

- Pulls source from GitHub via AWS CodeConnections (OAuth, no tokens)
- Runs a synth step (install + `cdk synth`)
- Self-mutates if the pipeline definition changes
- Deploys to ordered stages with optional manual approval and bake time

## Usage

```ts
// cdk-blocks/pipeline.cdk.ts
import { App } from 'aws-cdk-lib';
import { Pipeline } from '@aws-cdk-blocks/core/cdk';

const app = new App();

await Pipeline.create(app, 'Pipeline', {
  source: {
    repo: 'my-org/my-app',
    connectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/abc',
  },
  synth: {
    commands: ['npm ci', 'npx cdk synth --app "npx tsx -C cdk cdk-blocks/pipeline.cdk.ts"'],
  },
  branches: [
    {
      branch: 'main',
      stages: [{ name: 'beta' }],
    },
  ],
});
```

The file sits beside the app's `cdk-blocks/index.cdk.ts`. With neither
`stageFactory` nor `appFile`, `Pipeline.create()` imports `./index.cdk.ts`
(resolved relative to the calling file) once per stage, with the stage's
`environment` set on `process.env`, and the `BlocksStack.create()` call in
that file attaches its stack to the stage. The explicit `--app` selects the
pipeline for the synth step. Keep `cdk.json` pointed at `cdk-blocks/index.cdk.ts`
for local app deploys. To deploy the pipeline itself from the project root,
run `npx cdk deploy --app "npx tsx -C cdk cdk-blocks/pipeline.cdk.ts"`.

For multiple stages with the same app file, give each stage a distinct
`BlocksStack.create()` ID. For example, set `environment: { APP_STAGE: 'beta' }`
and `environment: { APP_STAGE: 'prod' }` on the stages, and use
`` `MyApp-${process.env.APP_STAGE ?? 'local'}` `` as the ID in `index.cdk.ts`.
The backend module is imported by stack ID: if two stages reuse the ID,
top-level block declarations run only for the first, even though both stages
synthesize. Use the existing stack ID when deploying an existing stack.

The CodeConnections connection needs a one-time OAuth handshake in the AWS
Console (Developer Tools → Connections) before the pipeline can pull source.
Until then its status is `PENDING`.

To build the stacks of a stage yourself, pass a `stageFactory`:

<!-- doc-snippet: skip — MyAppStack stands for your app's own stack class -->
```ts
import { Pipeline } from '@aws-cdk-blocks/pipeline';

new Pipeline(stack, 'Pipeline', {
  source: {
    repo: 'my-org/my-app',
    connectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/abc',
  },
  branches: [
    {
      branch: 'main',
      stages: [
        { name: 'beta' },
        { name: 'prod', requireApproval: true, config: { domain: 'myapp.com' } },
      ],
    },
  ],
  stageFactory: (scope, stageConfig) => {
    new MyAppStack(scope, 'App', { env: stageConfig.env });
  },
});
```

### `Pipeline.create()` and `new Pipeline()`

| | `await Pipeline.create(scope, id, props)` | `new Pipeline(scope, id, props)` |
|---|---|---|
| `scope` | A `Stack`, or an `App` (the pipeline is then wrapped in a `Stack` with the same `id`) | A `Stack`; an `App` throws |
| `stageFactory` | Synchronous or `async` (for example one that awaits `BlocksStack.create()`) | Synchronous only; an `async` function throws |
| `appFile` | Supported; defaults to `'./index.cdk.ts'` when `stageFactory` is omitted | Throws; `stageFactory` is required |
| `source.connectionArn` | A string or a `config()` marker | A string; a marker throws |

## Options

`PipelineProps`:

| Prop | Type | Default | Description |
|---|---|---|---|
| `source` | `PipelineSourceConfig` | required | The repository and its connection (below). |
| `branches` | `BranchConfig[]` | required | One CodePipeline per entry. Must not be empty; branch names must be unique. |
| `stageFactory` | `(scope: Stage, stageConfig) => void \| Promise<void>` | | Adds the stacks of one stage. Called once per stage. Mutually exclusive with `appFile`. |
| `appFile` | `string` | `'./index.cdk.ts'` with `Pipeline.create()` and no `stageFactory` | CDK app file imported once per stage, with the stage's `environment` set on `process.env`. Resolved relative to the calling file. Must be `.ts`, `.js`, `.mjs` or `.cjs` and inside the project root. Never take this path from external input: the file is executed during synth. |
| `synth` | `PipelineSynthConfig` | | The synth step (below). |
| `postStage` | `(context: PostStageContext) => Array<ShellStep \| CodeBuildStep> \| undefined` | | Steps to run after each stage deploys. See [`postStage`](#per-stage-post-deploy-steps-poststage). |
| `buildSecrets` | `Record<string, SecretValue \| ISecret>` | | Exposes a `secret('…')` marker or `ISecret` as `$NAME` in the synth build; `config()` is not accepted. CodeBuild fetches the value at build time rather than embedding it in the template. |
| `secretStore` | `KindStoreOptions` | prefix `/hosting/secrets` | Where `buildSecrets` markers are read from. Must match the prefix the values were set with. |
| `configStore` | `KindStoreOptions` | prefix `/hosting/config` | Where a `config()` `connectionArn` is read from. |
| `selfMutation` | `boolean` | `true` | Whether the pipeline updates its own definition. |
| `crossAccountKeys` | `boolean` | `false` | KMS keys for artifact encryption. Must be `true` when a stage's `env.account` differs from the pipeline's account, or synth throws. |

CodeBuild masks the exact stored secret in logs, not transformed values.
Avoid logging either. For a secret encrypted with a customer-managed KMS
key, make sure the synth build role can decrypt with that key; passing the
`ISecret` does not grant that permission.

`Pipeline` from `@aws-cdk-blocks/core/cdk` takes the same props and defaults the two
prefixes to the ones the AWS CDK Blocks `secret` and `config` scripts write:
`/blocks/<stackId>/secrets` and `/blocks/<stackId>/config`, or
`/blocks/secrets` and `/blocks/config` when the app has no `stackId`.

`source` (`PipelineSourceConfig`):

| Field | Type | Default | Description |
|---|---|---|---|
| `repo` | `string` | required | `owner/repo`. |
| `connectionArn` | `string \| ConfigValue` | required | ARN of the CodeConnections connection. A `config('KEY')` marker is resolved at synth and written into the template; it needs `Pipeline.create()`. `secret()` is not accepted. |
| `triggerOnPush` | `boolean` | `true` | Whether a push to the branch starts the pipeline. |
| `triggerFilters` | `string[]` | | Path patterns (for example `['packages/backend/**']`): the pipeline starts only for pushes that change matching files. With filters set, a branch's `triggerOnPush: true` throws. |

`branches[]` (`BranchConfig`):

| Field | Type | Default | Description |
|---|---|---|---|
| `branch` | `string` | required | The Git branch. |
| `stages` | `PipelineStageConfig[]` | required | Deployed in order. At least one; names unique within the branch. |
| `triggerOnPush` | `boolean` | `source.triggerOnPush` | Overrides `source.triggerOnPush` for this branch. |

`stages[]` (`PipelineStageConfig`):

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | required | The last part of the CDK Stage id (`<id>-<branch>-Stage-<name>`), which prefixes the stack names: starts with a letter; letters, digits and hyphens only. |
| `env` | `cdk.Environment` | the pipeline's account and region | Target account and region. |
| `requireApproval` | `boolean` | `false` | Manual approval before the stage deploys. |
| `approvalComment` | `string` | `Approve deployment to <name>` | Comment shown in the approval. |
| `bakeTime` | `cdk.Duration` | | Wait after the deploy before the pipeline proceeds. Use a positive whole number of minutes, such as `Duration.minutes(5)`. Runs as a CodeBuild `sleep` step with a timeout of `bakeTime` plus 10 minutes. |
| `config` | `TConfig` | | Your own per-stage settings, passed to `stageFactory` as `stageConfig.config`. |
| `environment` | `Record<string, string>` | | Variables set on `process.env` while `appFile` is imported for this stage (synth time only). Applies with `appFile` only. |

`synth` (`PipelineSynthConfig`):

| Field | Type | Default | Description |
|---|---|---|---|
| `commands` | `string[]` | `['npm ci', 'npx cdk synth']` | Commands of the synth step. |
| `installCommands` | `string[]` | none | Commands of the CodeBuild install phase, before `commands`. |
| `buildImage` | `codebuild.IBuildImage` | `LinuxBuildImage.AMAZON_LINUX_2023_5` | The build image. |
| `computeType` | `codebuild.ComputeType` | `ComputeType.MEDIUM` | `SMALL` warns at synth. Raise it when synth runs out of memory (exit code 137). |
| `env` | `Record<string, string>` | | Environment variables of the synth step. `NODE_OPTIONS` always starts with `--conditions=cdk`; your value is appended. |
| `primaryOutputDirectory` | `string` | `'cdk.out'` | Directory of the cloud assembly, for example `packages/infra/cdk.out` in a monorepo. |
| `dockerEnabled` | `boolean` | `false` | Enables Docker in the synth step, for Docker image assets. |
| `partialBuildSpec` | `codebuild.BuildSpec \| null` | Node.js 22 runtime | See [Controlling the synth runtime](#controlling-the-synth-runtime). |

## Per-stage post-deploy steps (`postStage`)

`postStage` is called once per deploy stage and returns the steps to run after
that stage deploys, for example a step that consumes the stage's deploy
outputs:

<!-- doc-snippet: skip — MyAppStack stands for your app's own stack class -->
```ts
import { Duration } from 'aws-cdk-lib';
import { CodeBuildStep } from 'aws-cdk-lib/pipelines';

new Pipeline(stack, 'Pipeline', {
  source: { repo: 'my-org/my-app', connectionArn: '...' },
  branches: [{ branch: 'main', stages: [{ name: 'beta' }, { name: 'prod', bakeTime: Duration.minutes(10) }] }],
  stageFactory: (scope, stageConfig) => new MyAppStack(scope, 'App', { env: stageConfig.env }),
  postStage: ({ stage, stageConfig, source }) => [
    new CodeBuildStep(`Smoke-${stageConfig.name}`, {
      input: source, // the checked-out source of this stage's branch
      env: { STAGE: stageConfig.name },
      commands: ['npm ci', 'npm run smoke'],
    }),
  ],
});
```

The hook receives a `PostStageContext`:

- `stage`: the CDK `Stage` the returned steps attach to.
- `stageConfig`: the full stage config, including `env` (the stage's target
  account/region); read it to make a post step target the same account/region.
- `source`: the pipeline source file set for this stage's branch. Use it as a
  step's `input` so the step runs against the already-checked-out source.

With `bakeTime`, baking starts after the `postStage` steps complete. Returning
`undefined` (or `[]`) adds nothing.

## Controlling the synth runtime

`synth.partialBuildSpec` sets the synth step's CodeBuild runtime:

- Omitted (`undefined`): the synth step declares Node.js 22 as the runtime.
- `null`: no `partialBuildSpec` is injected, so the synthesized buildspec
  contains no `runtime-versions` block. Use this to bring your own runtime
  (for example `synth: { partialBuildSpec: null, installCommands: ['n 20'] }`)
  or to rely on the build image's built-in runtime.
- A `BuildSpec`: used as-is, replacing the Node.js 22 default.

### Pin a specific Node.js version

```ts
import { BuildSpec } from 'aws-cdk-lib/aws-codebuild';

new Pipeline(stack, 'Pipeline', {
  // ...
  synth: {
    partialBuildSpec: BuildSpec.fromObject({
      phases: { install: { 'runtime-versions': { nodejs: 20 } } },
    }),
  },
});
```
