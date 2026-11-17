# Runtime configuration

Values supplied when a `Blocks` instance is built, as opposed to the build-time values in the
[Gradle plugin](gradle-plugin.md). Configuration is long-lived and usually the same for every
instance in a process; values that govern a single operation are *options* and are passed to that
operation instead, as `OidcSignInOptions` is to a [sign-in](oidc.md).

## Building an instance

Three forms, shortest first:

```kotlin
Blocks()                                                 // the spec's first server
Blocks(Servers.sandbox)                                  // a server the spec declares
Blocks(BlocksConfig(Blocks.defaultServer, "com.example.myapp"))   // anything beyond the server
```

### `Blocks()` and `Blocks.defaultServer`

Both are generated, not part of the runtime. The runtime never sees your spec, so it cannot know
which server to default to; codegen emits an `invoke` operator on `Blocks.Companion` that supplies
the spec's first one, and `Blocks.defaultServer` as the same server in value form. Regenerating
against a different backend therefore leaves either call site alone.

Reach for `Blocks.defaultServer` whenever you build a `BlocksConfig` and have no reason to pin a
particular environment — on the JVM that is every app that wants its session to persist. Naming a
generated constant like `Servers.local` there instead would pin a name the spec is free to rename,
and ties the call site to one environment.

Because they are extensions, they have to be imported:

```kotlin
import com.example.myapp.generated.invoke
import com.example.myapp.generated.defaultServer
```

Without the `invoke` import, `Blocks()` resolves to the runtime's own constructor and the compiler
reports a missing `server` argument — it points at the call, not at the import, so this is one
worth adding by hand if completion does not offer it.

The accessors for each API namespace (`blocks.api`, `blocks.authApi`) are generated extensions too,
but those resolve from the receiver, so an IDE offers them.

### `BlocksConfig`

`BlocksConfig` is a `data class`, so varying one value across environments is a `copy`:

```kotlin
val base = BlocksConfig(server = Blocks.defaultServer, applicationId = "com.example.myapp")
val staging = Blocks(base.copy(server = Servers.staging))
```

## The instance's HTTP engine

Every RPC call and every OIDC client share the one HTTP engine the instance owns. File handles and
realtime channels open their own — see [transferables](transferables.md#http-clients).

`close()` shuts the instance's engine down, after which calls through it report the closed instance
rather than failing inside the HTTP client. `Blocks` implements `AutoCloseable`, but `use { }` is
the wrong idiom for it: the instance is meant to live as long as the application, not one block.
Hold one and close it at shutdown — and on Android, tie it to the application rather than to an
`Activity`.

## Identifying your application

```kotlin
val blocks = Blocks(BlocksConfig(server = Blocks.defaultServer, applicationId = "com.example.myapp"))
```

`applicationId` is a stable identifier for your application, conventionally reverse-DNS. It keeps
one application's stored data apart from another's, and it is consulted only where the platform
does not already do that for you.

**On desktop, a session survives a restart only when you set it.** Android gives each application a
private sandbox and iOS a Keychain access group, so both ignore the value. A desktop machine gives
an application no private storage at all — `$HOME` is shared by every process you run — so without
an id there is nowhere to put the data that another Blocks application could not also reach. The
session is held in memory for the life of the process instead, and the user signs in again on the
next launch. There is no error and no warning, so if sign-in is not surviving a restart, this is
why.

The same id in two applications means one shared session, which is the thing it exists to prevent.
Pick a value unique to your application and keep it: changing it later points the application at a
different directory, which reads to the user as being signed out.

Because it is one value on `BlocksConfig` rather than a per-target one, shared multiplatform code
configures it once with no platform-specific source sets — see [`example/kmp`](../example/kmp).

### Where each target stores it

| Platform | Cookie storage |
|---|---|
| Android | `EncryptedSharedPreferences`, in the app's sandbox |
| iOS | Keychain Services, scoped to the app's access group |
| JVM | AES-256-GCM encrypted files under `~/.blocks/<applicationId>`, with the key held by the OS, or memory if no id is set |

On the JVM the entries themselves are protected by file permissions. On a POSIX filesystem (Linux,
macOS) they are owner-only (`rwx------` for the directory, `rw-------` for the files), which keeps
other OS users out. On Windows the runtime cannot set owner-only permissions, so the files keep the
access control list they inherit from your user profile (`%USERPROFILE%\.blocks\...`): by default
that keeps other standard users out, but administrators and the system account can still read them.

Where the key lives is the subject of the next section, and it is what decides whether a copy of
the directory is enough to read the session. In no case is the session protected from another
process running as the same OS user. If that is not acceptable for your application, leave
`applicationId` unset: the session is then held in memory only and never written to disk.

The JVM path is one location on every desktop OS, in the manner of `~/.aws` or `~/.gradle`. An id
is reduced to characters a directory name can hold; when that reduction changes anything, a digest
of the id as you wrote it is appended, so two ids that would otherwise reduce to the same name keep
separate directories.

There is deliberately no way to name the directory outright. The id is what the runtime needs in
order to keep applications apart, and a path would be a second way to say the same thing — with
the failure mode that two applications can be pointed at one directory by mistake.

### What desktop storage protects

The key that encrypts those files is held by the host operating system — the Keychain on macOS, the
Secret Service on Linux, the Data Protection API on Windows — rather than written beside them.
Entries copied off the machine in a backup, a disk image or a synced folder therefore cannot be
decrypted elsewhere.

**This is not a boundary against other software on the machine.** A desktop OS gives an application
no private storage, and its secret stores are reachable by anything running as the same user, so
another program the user runs can read a stored session. What limits the exposure is the session's
own lifetime and the backend revoking it at sign-out, not local storage. Treat desktop storage as
convenience across restarts rather than as a security boundary. Android and iOS are different: there
the OS does isolate one application's storage from another's.

macOS is a partial exception. A keychain item is bound to the code identity of the program that
created it, so a program built on a different Java runtime is refused until the user consents. Two
applications bundling the same runtime share one identity, and an application that changes its
bundled runtime prompts its user once.

Where no OS secret store can be used, the key is kept beside the entries instead and the at-rest
protection above is simply absent. On Linux that is the normal case outside a desktop session: a
server, a container or a CI runner has no keyring daemon to hold the key, so the file is used. So is
any application packaged as a standalone installer without the declarations native access needs:

```kotlin
compose.desktop {
    application {
        nativeDistributions {
            modules("jdk.unsupported")
        }
        jvmArgs += "--enable-native-access=ALL-UNNAMED"
    }
}
```

Omitting either costs the protection, not correctness — nothing fails, and sessions still persist.

## Signing out

Call the backend's own sign-out — on a generated auth namespace, or `OidcClient.signOut()`. It
revokes the session server-side and expires the cookie as part of its response, so the local copy
goes with it.

There is no public method for clearing stored state locally, and that is deliberate: dropping the
cookie without telling the backend leaves a live session on the server that the user believes is
gone.

## Upgrading from a release that wrote to `~/.blocks` directly

Versions of this runtime that predate `applicationId` wrote the cookie jar to `~/.blocks/cookies`,
with no per-application component, so every Blocks application run by one OS user shared it. Those
entries are not read and not migrated, so a signed-in user signs in once more after upgrading. The
old `~/.blocks/cookies` directory is not removed; delete it by hand if you want it gone.
