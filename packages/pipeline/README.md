# @aws-blocks/pipeline

CDK Pipelines-based CI/CD construct for AWS Blocks applications.

Creates one self-mutating CodePipeline V2 per branch. Each pipeline:

- Pulls source from GitHub via AWS CodeConnections (OAuth, no tokens)
- Runs a synth step (install + `cdk synth`)
- Self-mutates if the pipeline definition changes
- Deploys to ordered stages with optional manual approval and bake time

## Usage

```ts
import { Pipeline } from '@aws-blocks/pipeline';

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

For async stage factories (for example, `BlocksStack.create()`), use the static
`Pipeline.create()` method instead of `new Pipeline()`.

## Per-stage post-deploy steps (`postStage`)

The optional `postStage` prop runs a **second per-stage phase** after a stage
deploys — for example a step that consumes the stage's deploy outputs. It is invoked
once per deploy stage and returns steps that are attached as that stage's post-deploy
actions:

```ts
import { Duration } from 'aws-cdk-lib';
import { CodeBuildStep } from 'aws-cdk-lib/pipelines';

new Pipeline(stack, 'Pipeline', {
  source: { repo: 'my-org/my-app', connectionArn: '...' },
  branches: [{ branch: 'main', stages: [{ name: 'beta' }, { name: 'prod', bakeTime: Duration.minutes(10) }] }],
  stageFactory: (scope, stageConfig) => new MyAppStack(scope, 'App', { env: stageConfig.env }),
  postStage: ({ stage, stageConfig, source }) => [
    new CodeBuildStep(`Smoke-${stageConfig.name}`, {
      input: source, // the resolved pipeline source — see below
      env: { STAGE: stageConfig.name },
      commands: ['npm ci', 'npm run smoke'],
    }),
  ],
});
```

The hook receives a `PostStageContext`:

- **`stage`** — the CDK `Stage` the returned steps attach to.
- **`stageConfig`** — the full stage config, including `env` (the stage's target
  account/region); read it to make a post step target the same account/region.
- **`source`** — the **resolved pipeline source file set** for this stage's branch.
  Use it as a step's `input` so the step runs against the already-checked-out source.
  This is exposed precisely so a caller never has to walk the construct tree and
  string-match internal stage IDs to rediscover the source (which silently breaks on
  any internal rename).

**Ordering with `bakeTime`.** When a stage has both `postStage` steps and a
`bakeTime`, the bake step is made to **depend on** the post-stage steps, so baking
begins only after they complete rather than racing them in parallel. Returning
`undefined` (or `[]`) adds nothing and leaves synthesis identical to a pipeline with
no hook.

## Controlling the synth runtime

The synth step's CodeBuild runtime can be customized via `synth.partialBuildSpec`.
It accepts three forms:

- **Omitted** (`undefined`): the synth step declares Node.js 22 as the runtime.
  This is the default and recommended path.
- **`null`**: explicit opt-out. No `partialBuildSpec` is injected, so the
  synthesized buildspec contains no `runtime-versions` block. Use this to bring
  your own runtime (for example via `synth.installCommands`) or to rely on the
  build image's built-in runtime.
- **A `BuildSpec`**: used as-is, replacing the Node.js 22 default.

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

### Opt out of the Node.js 22 default

Pass `null` to suppress the injected runtime entirely and manage it yourself:

```ts
new Pipeline(stack, 'Pipeline', {
  // ...
  synth: {
    partialBuildSpec: null,
    installCommands: ['n 20'], // or rely on the build image's default runtime
  },
});
```
