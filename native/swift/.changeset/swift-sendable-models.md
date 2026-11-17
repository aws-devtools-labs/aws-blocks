---
"aws-blocks-swift": minor
---

Generated models are `Sendable`

Generated structs, enums and unions now conform to `Sendable` when everything they store does, so a Swift 6 actor can keep or return an `AuthState`, or take an `AuthActionInput`, without "sending ... risks causing data races". A type that stores a `RealtimeChannel` doesn't conform, nor does a type that stores one of those.
