---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

The `cdk bootstrap` command that `npm run deploy` and `npm run sandbox` print for an account and Region that were never bootstrapped now passes `--express`: `npx cdk bootstrap aws://<account-id>/<region> --app= --express`. CloudFormation then creates the `CDKToolkit` stack in Express mode, reporting each resource complete without waiting for it to stabilize, so the bootstrap finishes sooner. CDK CLI versions before 2.1129.0 ignore the flag and bootstrap as before.
