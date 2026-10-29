---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

`npm run deploy` and `npm run sandbox`, including each deployment of the sandbox's watch mode, now explain when AWS denies a request of the deployment itself, for example a CloudFormation resource that fails with `is not authorized to perform`. The explanation follows as soon as the failure is reported, without waiting for CloudFormation's rollback, and once per deployment. It says whether an AWS Organizations policy (a service control policy or a resource control policy) explicitly denied the request, which signing in again or adding IAM permissions does not change. It contains none of the error's account IDs, ARNs or policy IDs, and the commands fail with the same output, errors and exit codes as before. The CDK CLI's hard-wrapped error lines, terminal colors, CRLF line endings and the `AuthorizationError` and `UnauthorizedOperation` errors are recognized; the CDK CLI's note that names AccessDenied as an example of what `cdk diagnose` finds, resource names, and app logs in watch mode are not treated as a denial.

After such a failure, `npm run sandbox` replaces its Express Mode recovery note with guidance that does not risk the sandbox's data: after the first deploy of a sandbox, `npm run sandbox:destroy` removes the stack it left; a sandbox that existed before must not be destroyed. Other failures keep the Express Mode note.

When credentials expire or are rejected during `npm run sandbox`, including in its watch mode, the sandbox now prints the sign-in guidance of the pre-deploy credential check for the profile or access keys that it deploys with, once per deployment, and says whether saving a file or restarting `npm run sandbox` picks up the new credentials.

The initial sandbox deploy now reads the CDK CLI's stderr to do this, and passes `--progress events` to `cdk deploy`, so it prints one line per CloudFormation event (as `npm run deploy` does) instead of a progress bar. Its stdin and stdout still go to the terminal.
