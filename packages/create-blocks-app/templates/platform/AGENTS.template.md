
## Platform rules (this app runs on a shared app platform)

This app shares one AWS account with many other apps. The platform keeps them apart, and it will reject a deploy that breaks these rules — so follow them from the start:

- **Build with Building Blocks only.** Don't write IAM policies, roles, grants (`addToPrincipalPolicy`, `grant*` on raw CDK constructs) or attach managed policies by hand.
- **Never reference another app's resources.** Don't call `fromExisting(...)` with a name or ARN that isn't this app's, and don't name resources yourself — let the Building Blocks name them (every name starts with this app's id).
- **Don't edit the platform's files:** `aws-blocks/index.cdk.ts`, `cdk.json`, and the deploy workflow. They set this app's identity (`defaults.app`) and the permissions boundary. Ask a platform reviewer instead.
- **Check before you push:** `APP_ID=<this app's id> npm run check:iam` runs the same IAM check the pipeline runs (`blocks-iam-check`). Synth also fails on any violation, because `defaults.app.strict` is on.
