---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
---

Fix off-region CloudFront 5xx alarm and rework alarm subscription wiring (#481).

**Breaking change** (a minor bump pre-1.0):

- The `monitoring.snsTopicArn` prop is **removed**. Attach notifications
  with the new `monitoring.subscriptions` list instead: `EmailSubscription`
  and `UrlSubscription` from `aws-cdk-lib/aws-sns-subscriptions` (endpoint
  subscriptions only, for now). Each subscription is applied to **both**
  hosting alarm topics, so you subscribe in one place and every alarm is
  covered regardless of region.
- The `hosting.monitoringTopic` attribute is **removed**, replaced by
  `hosting.monitoring` = `{ alarms, alarmTopics }` (all alarms and all
  alarm topics across both regions).

`AWS/CloudFront` metrics publish only in us-east-1 and a CloudWatch alarm
cannot watch a metric cross-region, so off-region the CloudFront 5xx alarm
never fired (it sat at `OK` under `treatMissingData: NOT_BREACHING`).
Off-region deployments now **always** place the CloudFront alarm in a
synthesized `<stackName>-CfMonitoring-<addr>` us-east-1 stack with its own
encrypted SNS topic; `monitoring.subscriptions` are applied to that topic
too. Off-region placement is always on; the only escape is when it is
genuinely impossible. When the region resolves but the account is
unresolved (a single-synth multi-account pipeline), the us-east-1 support
stack cannot be built, so the CloudFront alarm is skipped with a loud synth
warning and all other alarms are kept, rather than throwing. Set
`env: { account, region }` to enable CloudFront coverage.

Migration: replace `monitoring: { snsTopicArn }` with
`monitoring: { subscriptions: [new subs.EmailSubscription('oncall@example.com')] }`
(or a `UrlSubscription`). Two escape paths cover what `subscriptions` no
longer does directly:

- **Route alarms to an existing/central SNS topic:**
  `hosting.monitoring.alarms.forEach(a => a.addAlarmAction(new cw_actions.SnsAction(myTopic)))`.
- **Resource-target (Lambda/SQS) subscriptions:** still valid on the
  regional topic via `hosting.monitoring.alarmTopics[].addSubscription(...)`.
  Only the automatic cross-region fan-out to the us-east-1 CloudFront topic
  drops them (that would need an unresolvable cross-region reference).

See `docs/DECISIONS.md` D-016 for the always-on and warn-and-skip rationale.

`@aws-blocks/core` surfaces `monitoring.subscriptions` and the
`monitoring` attribute in place of `monitoringTopic`.
