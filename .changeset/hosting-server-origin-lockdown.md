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
web ACL with the distribution's rules and rate limit. Its CloudWatch Logs keep
only the requests a rule blocked or counted, with the `Referer`, `Cookie` and
`Authorization` headers redacted, and it keeps no sampled requests.

Cost: with `waf.enabled`, a second web ACL per stack: its monthly charge, a
per-request charge (every uncached SSR request is evaluated by both web ACLs),
and the log ingestion of blocked and counted requests. Every CloudFront + SSR
stack also gets one Secrets Manager secret (two with Nuxt IPX), each with a
small monthly charge.

New `frontDoor.features.serverOrigin` settings:

- `accessLogging` (default `false`): JSON stage access logs in CloudWatch Logs.
  It creates the account-level API Gateway CloudWatch Logs role once per stack.
- `logRetention` (default one month): retention of those logs and of the
  stage web ACL's logs.
- `verifySecretRotation`: bump it to rotate the origin-verify secrets.
- `acceptLegacyVerifyHeader`: accept the earlier derived value for one deploy
  while upgrading. Synth warns while it is set.

Upgrading: the first deploy updates the REST API policy within seconds and the
distribution within minutes, so SSR requests can get 403 for those minutes.
To avoid this, deploy once with `serverOrigin: { acceptLegacyVerifyHeader: true }`,
then deploy again without it. For that deploy the SSR REST API also keeps the
IPX image routes it served before, and its stage web ACL is attached only on
the next deploy, once every edge sends the marker its rate rule exempts.
