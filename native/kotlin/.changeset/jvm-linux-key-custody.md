---
"aws-blocks-kotlin": minor
---

Hold the JVM session encryption key in the Linux Secret Service

On Linux the key that encrypts stored sessions was kept beside the entries it protected, so anything
able to read the entries could read the key. It is now held by the session keyring, which completes
the set alongside the macOS Keychain and the Windows Data Protection API. Entries copied off the
machine in a backup, disk image or synced folder can no longer be decrypted elsewhere.

Where no keyring is running — a server, a container, a CI runner — the key falls back to a file
beside the entries, as before. Nothing fails; the at-rest protection is simply absent there.
