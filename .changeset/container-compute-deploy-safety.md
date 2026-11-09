---
"@aws-blocks/bb-container-compute": patch
"@aws-blocks/core": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-compute": patch
---

fix(bb-container-compute): deploys no longer reset an autoscaled container's task count

A container `Compute` with autoscaling no longer declares a task count in its
CloudFormation template. Before, every deploy that changed the app's code reset
the running task count to `minInstances`, stopping tasks that were running jobs.

Running jobs also get longer to finish when a task is stopped by a deploy or by
scale-in: the container now waits up to 120 seconds (the AWS Fargate maximum),
up from 25 seconds. A job still running after that is stopped and retried.

The `bb-compute`, `bb-async-job` and `bb-cron-job` READMEs now say that a deploy
restarts a job still running after that window, and that the restart counts as
one of the job's attempts.
