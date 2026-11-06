---
"@aws-blocks/bb-async-job": patch
---

An `AsyncJob` whose scope id contains a character SQS doesn't allow in queue names, such as `.`, now deploys. Its queue and dead-letter queue names replace those characters with `-` and add a short hash of the full id, so ids that differ only there stay distinct. Such a job previously passed synth and then failed the deploy. Any queue name that could already deploy is unchanged, including when the disallowed characters fall past the 80-character cut-off.
