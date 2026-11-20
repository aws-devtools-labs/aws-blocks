---
"@aws-cdk-blocks/core": patch
---

fix(core): `defaults.appIdentity` reports more of what reaches outside the app

The IAM report's app-isolation check (`cdk.out/<stack>.blocks-iam.json`) now
also flags:

- a resource policy that lets in someone who isn't this app — everyone,
  another account, another app's role, `NotPrincipal`, or a public Lambda
  function URL — in a Lambda or layer permission, or a bucket, queue, topic,
  secret, KMS key or replica key, REST API or EventBridge bus policy, in any of
  the app's stacks, including Hosting's helper and edge stacks. A service
  principal, the app's own roles and the account's root are fine, and everyone
  only when a condition pins it to the app's own ARNs in this account
  (`aws:SourceArn`, `aws:PrincipalArn`), to `aws:PrincipalTag/app` together
  with `aws:PrincipalAccount`, or on a public REST API. A policy the check
  can't read (an intrinsic, a string) is reported;
- a name-fenced resource (table, queue, bucket, function, layer, parameter,
  log group, RDS cluster or instance, vector bucket, event rule or bus,
  schedule, secret or state machine) that the app names outside its prefix, which the platform's
  execution policy would refuse to create;
- a literal grant on another app's Lambda layer, RDS cluster or instance (also
  through the RDS Data API) or S3 Vectors bucket, which was checked only for a
  wildcard before.

Lambda layer names that `appIdentity` truncates to 140 characters now end in a
hash of the whole logical id, so two long logical ids no longer get the same
name. The core README's pipeline check also rejects a report written with
`reportOnly`, which the app's own code sets.
