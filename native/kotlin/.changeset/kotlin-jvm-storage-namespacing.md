---
"aws-blocks-kotlin": minor
---

Give each application its own storage on the JVM

An application now identifies itself with `BlocksConfig.applicationId`, conventionally reverse-DNS, and on the JVM its stored data goes to `~/.blocks/<applicationId>`. Previously every Blocks JVM application run by the same OS user read and wrote `~/.blocks/cookies`, so two applications against one backend held a single session and a debug build could overwrite the session of anything else on the same origin. Android and iOS ignore the value: the OS already gives each application a private location. A `Blocks` instance also now owns its cookie jar rather than sharing one per process, with instances that persist to the same place sharing one jar so they cannot discard each other's cookies.

**A JVM or desktop application that sets no `applicationId` now holds its session in memory and forgets it when the process ends.** There is no default, because any default would be a directory every Blocks application shares — the defect being fixed. Entries written directly to `~/.blocks/cookies` are no longer read or migrated, so a signed-in caller signs in once more after upgrading; nothing removes that directory.

**`BlocksClient.clearCookies()` is removed.** Signing out is a call to the backend's own sign-out, which revokes the session and expires the cookie; clearing locally left a live server session behind. `Blocks.clearStoredState()` replaces it for test isolation and is marked `@InternalBlocksApi`.

Realtime channels and file handles no longer carry a cookie jar. Each authenticates with the credential on its own URL, and neither could reach a per-instance jar.

Codegen also emits `Blocks.defaultServer`, the spec's first server as a value rather than only as the server the no-argument `Blocks()` reaches. A client that configures anything has to assemble a `BlocksConfig`, which names a server — on the JVM that is now every client that wants its session to persist — and without this it would have to name a generated constant directly, pinning a server name the spec is free to change.
