---
"aws-blocks-swift": minor
---

feat(swift): fall back to UnknownTransferable for unbound transferable results

A direct method result whose `x-blocks-transferable` tag has no known runtime
binding now returns the public `UnknownTransferable` instead of a raw `Data?`
that did not type-check, with one `AWSBLOCKS-NATIVE-001` diagnostic per unbound
operation. A known transferable's inline type argument is now emitted as a
qualified type (e.g. `RealtimeChannel<GetChannel.ResultMessage>`), so a generic
transferable result compiles, and a nullable bound transferable result now
hydrates to its optional concrete type; the unbound fallback stays direct-only.
