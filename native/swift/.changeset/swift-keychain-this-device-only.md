---
"aws-blocks-swift": patch
---

fix(swift): store Keychain cookies with a this-device-only accessibility class and check the store result

Cookies are now stored with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` instead of
`kSecAttrAccessibleAfterFirstUnlock`. The class is applied on every write, so a cookie stored by an
earlier version moves to the new class in place the next time it is written, keeping its value — a
signed-in session is not lost. A Keychain add or update that does not succeed is now logged instead
of being ignored.

Because these items can only be read and written while the device is unlocked, the cookie store
now also keeps the jar in memory. While the Keychain cannot be read, requests carry the cookies
from that copy; a cookie set or removed while the Keychain refuses the change is kept and written
again on the next call, so a response that arrives while the device is locked does not lose the
cookies it sets.
