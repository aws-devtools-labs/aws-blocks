---
"@aws-blocks/hosting": minor
"@aws-blocks/blocks": minor
---

feat(hosting): lock the CloudFront door's server origin with a random secret, a regional web ACL and opt-in access logs

The API Gateway REST API that CloudFront reaches the SSR Lambda through now
requires a random origin-verify `Referer` value that Secrets Manager generates
once per stack. The REST API policy and the CloudFront origin read it through a
CloudFormation dynamic reference, so it no longer appears in the template and
can't be derived from the stack name. A Nuxt IPX image optimizer gets its own
REST API with its own secret.

With `waf: { enabled: true }`, each server-origin stage also gets a REGIONAL
web ACL with the distribution's rules and rate limit, logged to CloudWatch Logs.
This adds a second web ACL to the stack's monthly cost.

New `frontDoor.features.serverOrigin` settings:

- `accessLogging` (default `false`): JSON stage access logs in CloudWatch Logs.
  It creates the account-level API Gateway CloudWatch Logs role once per stack.
- `logRetention` (default one month): retention of those logs and of the
  stage web ACL's logs.
- `verifySecretRotation`: bump it to rotate the origin-verify secrets.
- `acceptLegacyVerifyHeader`: accept the earlier derived value for one deploy
  while upgrading.

Upgrading: the first deploy updates the REST API policy within seconds and the
distribution within minutes, so SSR requests can get 403 for those minutes.
To avoid this, deploy once with `serverOrigin: { acceptLegacyVerifyHeader: true }`,
then deploy again without it.
