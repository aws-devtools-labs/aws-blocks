---
"aws-blocks-kotlin": patch
---

Store the iOS cookie jar with a this-device-only Keychain accessibility class

On iOS the cookie jar is now stored with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` instead of `kSecAttrAccessibleAfterFirstUnlock`. The class is applied when the item is updated as well as when it is created, so a jar stored by an earlier version moves to the new class in place on its next write, keeping its cookies — a signed-in session is not lost. A write attempted while the device is locked now fails and is retried on the next call, as other failed writes already are.
