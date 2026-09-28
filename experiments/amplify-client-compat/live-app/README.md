# Live sign-in test (M2)

A Blocks app with one `AuthCognito` pool, plus a runner that signs into it
with the real `aws-amplify@6` client. Nothing here has been deployed yet.

- `aws-blocks/index.ts`: `AuthCognito` (email sign-in, self sign-up, MFA off,
  `removalPolicy: 'destroy'`) and an `api.whoAmI` probe.
- `aws-blocks/index.cdk.ts`: `BlocksStack` with the sandbox preset, plus three
  outputs for the emitter: `AmplifyUserPoolId`, `AmplifyUserPoolClientId`,
  `AmplifyRegion`.
- `live-signin.ts`: writes `amplify_outputs.json` from the deploy outputs and
  runs sign-up, admin confirm, sign-in, the token-issuer check and cleanup.

## What gets deployed

Stack `amp-live-signin` (from `cdk synth`): one Cognito user pool and app
client, 5 Lambda functions (the Blocks handler plus CDK helpers), an API
Gateway REST API, one DynamoDB table (sessions), an S3 bucket, 5 IAM roles, 2
log groups, and an SSM parameter created by a custom resource. The sandbox
preset removes everything on `cdk destroy`.

## Run

From the worktree root, with credentials for a **sandbox** account in the
shell and the account CDK-bootstrapped in the target region:

```bash
# once: node_modules from the main checkout
ln -sfn /home/rhamouda/workspace/aws-blocks/node_modules node_modules

cd experiments/amplify-client-compat/live-app
export AWS_REGION=us-west-2
../../../node_modules/.bin/cdk deploy amp-live-signin --require-approval never \
  --outputs-file .live/outputs.json

cd ../../..
node --import ./node_modules/tsx/dist/loader.mjs \
  experiments/amplify-client-compat/live-app/live-signin.ts \
  experiments/amplify-client-compat/live-app/.live/outputs.json

cd experiments/amplify-client-compat/live-app
../../../node_modules/.bin/cdk destroy amp-live-signin --force
```

The runner needs `cognito-idp:AdminConfirmSignUp` and
`cognito-idp:AdminDeleteUser` on the pool; it deletes its test user even on
failure. It exits 1 if a required step fails.

## Expected result

```
PASS signUp — CONFIRM_SIGN_UP
PASS adminConfirmSignUp — confirmed
PASS default signIn (SRP) rejected — <error from Cognito>
PASS signIn USER_PASSWORD_AUTH — DONE
PASS ID token issued by the Blocks pool — https://cognito-idp.us-west-2.amazonaws.com/<pool id>
INFO Blocks API whoAmI with Amplify token — HTTP <status> <body>
PASS cleanup AdminDeleteUser — amp-live-…@example.com
```

The `INFO` line is not pass/fail: it records whether the Blocks API
recognises a user who signed in through Amplify (expected: it does not,
because Blocks authenticates API calls with its own session cookie).
