---
"aws-blocks-kotlin": minor
---

Hold the JVM session encryption key in the operating system

On desktop the key that encrypts stored sessions was kept in the same directory as the entries it
protected, so anything able to read the entries could read the key beside them. The key is now held
by the host OS — the Keychain on macOS, the Secret Service on Linux, the Data Protection API on
Windows. Entries copied off the machine in a backup, disk image or synced folder can no longer be
decrypted elsewhere.

Where no OS store can be reached — a server, a container, a CI runner, or a desktop session without
a keyring — the key falls back to a file beside the entries, as before. Nothing fails; the at-rest
protection is simply absent there.

This does not isolate a session from other programs the same user runs, which no storage on a
desktop OS does. The configuration guide now says so rather than describing the storage as
encrypted without qualification.

A desktop application packaged as a standalone installer needs the `jdk.unsupported` module and
`--enable-native-access=ALL-UNNAMED` for the key to reach the OS store. Omitting them costs the
protection, not correctness.

Existing desktop sessions are not migrated and sign in once more after upgrading.
