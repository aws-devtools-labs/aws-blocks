---
'@aws-blocks/core': patch
---

`sandbox:destroy` and production `destroy` now recognise a throttled teardown
even when the throttle check itself is throttled. After a failed delete attempt,
the retry reads the stack's events to decide whether AWS throttled it. When
several stacks in one account are torn down at once, that `DescribeStackEvents`
call often fails with `Rate exceeded` too. The retry then printed
`could not tell whether the delete was throttled`, fell back to the short 60s
and 120s waits, and gave up on a delete that only needed to back off. A throttle
check that fails with a throttling error (`Throttling`, `Rate exceeded`,
`TooManyRequestsException`, HTTP 429) now counts as a throttle, so the delete
gets the longer throttle backoff.

At `BLOCKS_LOG_LEVEL=quiet` or `normal`, where the CDK output of each attempt is
kept, a failed attempt whose output already names a throttle
(`Too Many Requests`, `Status Code: 429`, `Rate exceeded`) is treated as
throttled without the extra CloudFormation call.

A throttle check that fails for any other reason (for example, missing
`cloudformation:DescribeStackEvents` permission) keeps the 60s and 120s retry
schedule, as before.
