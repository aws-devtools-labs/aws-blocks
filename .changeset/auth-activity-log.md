---
"@aws-blocks/bb-auth": minor
"@aws-blocks/blocks": patch
---

`Auth` can export Cognito's own user-activity log. With `featurePlan: 'plus'` and `activityLog: true`, the user pool runs threat protection in audit-only mode and delivers its scored sign-in, sign-out and password events to a log group the stack owns, exposed on the CDK `Auth` as `activityLogGroup`. This covers what the `audit` records can't see, such as attempts on the managed login page. Sign-in behaves as before: audit-only mode never blocks or challenges a user.

It is off by default, because the Plus plan is billed per monthly active user. Synth refuses it without `featurePlan: 'plus'` or on a pool wrapped with `userPool`, and on a `store: 'builtin'` block it is a compile error. The README now lists where each auth event is recorded: the `audit` records, CloudTrail or this log.
