---
"@aws-blocks/hosting": minor
"@aws-blocks/core": patch
---

Fix off-region CloudFront alarm placement (#481).

`HostingConstruct` now correctly handles the AWS constraint that
CloudFront metrics only publish in `us-east-1`: when the hosting stack
is deployed to a non-`us-east-1` region the CloudFront 5xx alarm is
placed in a synthesized `<stackName>-CfMonitoring` us-east-1 stack that
owns its own encrypted SNS topic and exposes a `MonitoringTopicArnUsEast1`
CloudFormation output for operator subscriptions.

Off-region deployments now defer the CloudFront 5xx alarm to a synthesized
`<stackName>-CfMonitoring` us-east-1 stack (own SNS topic +
MonitoringTopicArnUsEast1 output); this requires env:{account,region} to
be set off-region. Set monitoring.cloudFrontAlarm:'skip' to opt out (emits
a warning).

`@aws-blocks/core` gains the `cloudFrontAlarm` property on
`HostingMonitoringOptions` to surface the new `'skip'` | `'usEast1Stack'`
choice at the L3 config layer.
