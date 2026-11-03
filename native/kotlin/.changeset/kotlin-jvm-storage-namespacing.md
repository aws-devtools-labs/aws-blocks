---
"aws-blocks-kotlin": minor
---

Give each application its own storage on the JVM

A `Blocks` instance now owns its cookie jar rather than sharing one per process, and on the JVM the application supplies the directory that jar is persisted to, through the new `BlocksConfig` and `BlocksPlatformConfig`. Previously every Blocks JVM application run by the same OS user read and wrote `~/.blocks/cookies`, so two applications against one backend held a single session and a debug build could overwrite the session of anything else on the same origin. Android and iOS are unchanged: the OS already gives each application a private location.

**A JVM or desktop application that supplies no `storageLocation` now holds its session in memory and forgets it when the process ends.** There is no default, because nothing on the JVM can derive one without reintroducing the shared directory. Entries under `~/.blocks` are no longer read or migrated, so a signed-in caller signs in once more after upgrading; nothing removes that directory.

**`BlocksClient.clearCookies()` is removed.** Signing out is a call to the backend's own sign-out, which revokes the session and expires the cookie; clearing locally left a live server session behind. `Blocks.clearStoredState()` replaces it for test isolation and is marked `@InternalBlocksApi`.

Realtime channels and file handles no longer carry a cookie jar. Each authenticates with the credential on its own URL, and neither could reach a per-instance jar.
