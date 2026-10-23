---
"aws-blocks-swift": patch
---

fix(swift): store Keychain cookies with a this-device-only accessibility class and check the store result

Cookies are now stored with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` instead of
`kSecAttrAccessibleAfterFirstUnlock`. The class is applied on every write, so a cookie stored by an
earlier version moves to the new class in place the next time it is written, keeping its value — a
signed-in session is not lost. A Keychain add or update that does not succeed is now logged instead
of being ignored.
