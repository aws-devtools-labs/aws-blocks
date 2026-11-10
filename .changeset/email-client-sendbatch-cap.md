---
"@aws-blocks/bb-email-client": minor
"@aws-blocks/blocks": patch
---

`EmailClient.sendBatch()` now takes at most 100 messages per call by default. A larger batch throws `InvalidInputException` (`Batch size 101 exceeds the maximum of 100 messages.`) and nothing is sent, locally and when deployed. Before, a single call could send any number of messages, so one request to an exposed method could fan out into an unbounded number of SES sends.

**Behavior change:** a `sendBatch()` call with more than 100 messages that worked before now throws. Split the messages across calls, or set the new `maxBatchSize` option (a positive integer) to raise the cap for a trusted server-side job. An invalid `maxBatchSize` throws `InvalidInputException` from the constructor, and fails at synth.

The SES send permission granted to the app's execution role is now scoped to the stack's own region and partition, instead of every region. The runtime only ever calls SES in the Lambda's own region, so this does not change what an app can send.

The README has a new security section: an `ApiNamespace` method that passes caller input to `send()` or `sendBatch()` without a gate is an open relay. It shows gating with `auth.requireAuth(context)` and building the message on the server. The umbrella `@aws-blocks/blocks` is bumped because the `bb-email-client` README/DESIGN docs it bundles have changed.
