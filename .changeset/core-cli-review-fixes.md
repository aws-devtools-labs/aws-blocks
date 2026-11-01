---
"@aws-blocks/core": patch
---

fix(core): production destroy and deploy guidance for the `blocks` CLI

- The production `destroy()` loads `.env.production` and sets `BLOCKS_STAGE=production`, as `deploy()` does, so it deletes with the credentials and Region the deploy used. Before, an `AWS_PROFILE` or `AWS_REGION` set only in `.env.production` was ignored, and the destroy targeted the default profile or another Region.
- The production `destroy()` takes an optional `stackName`. When CloudFormation has no stack of that name in the target Region, it prints `There is no stack <name> in Region <region>; nothing to delete.` and runs no `cdk destroy`, which reported a missing stack as `✅ Production stack destroyed!`.
- `openConsole()` takes an optional `region`, the Region the stack is in, instead of always using the configured Region.
- The deploy guidance can name the command the user runs: `assertAwsCredentials()` takes an `invocation` (default `npm run <command>`) for its no-Region, network and credential messages and the CDK bootstrap message; `DeployOptions`, `DestroyOptions` and `SandboxOptions` take an `invocation` (the sandbox also a `destroyInvocation`, for its Ctrl-C and failure recovery lines), and `destroySandbox(backendPath, { invocation })` passes it on, also to the Lambda@Edge re-run hint. Without them the messages are unchanged.
- With a `stackName`, the production `destroy()` first lists the CDK app's stacks with `cdk ls`, and refuses, deleting nothing, when the app does not define that stack: `cdk destroy` acts on the stacks `index.cdk.ts` defines, not on the name the caller confirmed.
- The error for a missing `.blocks/config.json` or `stackId` says that, for an app already deployed, `<id>-prod` must be the name of its existing production stack; another id makes the next deploy create a second production stack.
- `getStackId()` says `.blocks/config.json is not valid JSON (<parse error>)` for a file that does not parse, instead of "not found or missing stackId".
- `readAwsIdentity()` reports a selected profile that is not in the AWS config files even when no Region is set, instead of returning no identity, which `blocks whoami --profile <typo>` reported as "no AWS Region is set".
- The production deploy no longer lists "Frontend hosting (S3 + CloudFront)" for an app without a frontend.
- The first-run telemetry notice says `To disable: npx blocks telemetry disable`, and the `blocks-telemetry` usage starts with `npx blocks telemetry [status|enable|disable] [--global]`, the `blocks` CLI command, instead of naming only `npx blocks-telemetry --disable`.
- The production `destroy()` reads only stack ids from `cdk ls`: the frontend build and CDK notices that synthesizing the app prints to stdout are no longer listed as stacks in its "the CDK app defines …" refusal.
- The `npx cdk bootstrap` command that the bootstrap check prints passes `--profile <profile>` when the deploy uses a profile, so it bootstraps the same account from a shell that does not export `AWS_PROFILE`.
- `SandboxOptions.onDeployed`, when set, is called with the sandbox stack, its API URL and frontend URL after the first deploy, in watch mode too (before `cdk watch` starts), and awaited.
