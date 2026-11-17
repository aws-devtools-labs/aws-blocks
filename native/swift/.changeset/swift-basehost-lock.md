---
"aws-blocks-swift": patch
---

fix(swift): make `BlocksClient.baseHost` safe to set from Swift 6 code

`BlocksClient.baseHost` is now a computed property backed by a lock instead of a stored
`static var`. App code in Swift 6 language mode can set it, e.g.
`BlocksClient.baseHost = "192.168.1.10"`, without "reference to class property 'baseHost' is not
concurrency-safe because it involves shared mutable state", and it is safe from any thread.
Generated code no longer reads it: a realtime channel picks it up when `BlocksRuntime` decodes it.
