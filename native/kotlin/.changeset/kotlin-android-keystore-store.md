---
"aws-blocks-kotlin": patch
---

Move the Android credential store onto an Android Keystore key

The Android credential store now encrypts each value with an AES-256-GCM key held in the Android Keystore and keeps it in a plain `SharedPreferences` file, replacing the deprecated `EncryptedSharedPreferences` and `MasterKey` from `androidx.security:security-crypto`. Entries written by an earlier version are moved over automatically on first access, so a signed-in user stays signed in, and an upgrade interrupted partway finishes on the next access. A session whose key is gone, as after restoring the application's data onto another device, is dropped so the user signs in once instead of staying unrecoverable. On Android versions below 13 a key-store error during the one-time read of the earlier file is indistinguishable from a lost key, so that read drops the earlier session too; the new store itself reports such an error as a failed read and keeps the session. Downgrading after the migration signs the user out once; upgrading again keeps the session saved by the downgraded build. An earlier file the platform will not delete is recorded as taken over, so it is never read back over a newer session and does not undo a sign-out.
