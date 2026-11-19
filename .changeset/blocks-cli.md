---
"aws-cdk-blocks": minor
---

Run AWS Blocks app tasks through package scripts, including `npm run dev`, `npm run sandbox`, and `npm run deploy`. Deployment results are available with `npm run -s deploy -- --output json` or `npm run -s deploy -- --query apiUrl`. Progress goes to stderr for structured results. The lifecycle tasks return 0 for success, 1 for failure, 2 for invalid usage, and 130 for interruption. `aws-cdk-blocks/scripts` re-exports core lifecycle helpers and logging. The tasks load app-local `tsx` when available, and `aws-cdk-blocks/scripts` also exports `readAwsIdentity()`, `describeDeploymentCredentials()`, `resolveDeploymentTarget()`, and `log`.
