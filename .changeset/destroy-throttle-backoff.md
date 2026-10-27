---
'@aws-blocks/core': patch
---

`sandbox:destroy` and production `destroy` now ride out AWS API throttling
during teardown. When the stack's events show a resource delete failed on a
throttle (most often API Gateway's `DeleteRestApi` quota of one request every
30 seconds per account, hit when several stacks in one account are torn down at
once), the retry backs off exponentially with randomized waits (up to about 1,
2, 4, then 5 minutes) and keeps retrying for about 20 minutes after the first
failure, instead of giving up after the fixed 60s and 120s waits. The
randomization keeps parallel teardowns from retrying in lockstep. Because each
delete attempt can itself take several minutes, a destroy that stays throttled
can now run for about 30 minutes before it fails (about 18 minutes before this
change). When it does fail on a throttle, it says so and suggests waiting a few
minutes before running destroy again.

Failures that are not throttles keep the existing schedule (60s, then 120s),
except that none is retried once throttling has used up the 20-minute budget.
Detection reads the stack events with the caller's credentials
(`cloudformation:DescribeStackEvents`); if they cannot be read, a warning is
printed and the failure is treated as not throttled.
