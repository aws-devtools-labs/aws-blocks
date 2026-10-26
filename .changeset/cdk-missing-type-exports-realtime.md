---
"@aws-blocks/bb-realtime": patch
---

fix: export types missing from the `cdk` entry point

Some types exported by the default entry point of `@aws-blocks/bb-realtime` were missing from its `cdk` entry, so
backend code importing them failed to type-check under that condition — for example,
`import type { SubscribeOptions } from '@aws-blocks/bb-realtime'`.

The `cdk` entry now exports `RealtimeChannelDescriptor`, `SubscribeOptions`, `DisconnectReason`.
