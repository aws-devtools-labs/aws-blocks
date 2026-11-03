# Runtime configuration

Values supplied when a `Blocks` instance is built, as opposed to the build-time values in the
[Gradle plugin](gradle-plugin.md). Configuration is long-lived and usually the same for every
instance in a process; values that govern a single operation are *options* and are passed to that
operation instead, as `OidcSignInOptions` is to a [sign-in](oidc.md).

## `BlocksConfig`

```kotlin
val blocks = Blocks(BlocksConfig(server = Servers.prod))
```

`BlocksConfig` is a `data class`, so varying one value across environments is a `copy`:

```kotlin
val base = BlocksConfig(server = Servers.prod)
val staging = Blocks(base.copy(server = Servers.staging))
```

The shorter forms remain available: `Blocks()` follows the spec's first server, and
`Blocks(Servers.sandbox)` names one without building a config.

`Blocks()` following the spec means regenerating against a different backend leaves the call site
alone. It is the generated `invoke` import that brings that form into scope, and without the import
the compiler reports a missing `server` argument rather than a missing import — so it is worth
adding by hand if completion does not offer it.

## The instance's HTTP engine

Every RPC call and every OIDC client share the one HTTP engine the instance owns. File handles and
realtime channels open their own — see [transferables](transferables.md#http-clients).

`close()` shuts the instance's engine down, after which calls through it report the closed instance
rather than failing inside the HTTP client. `Blocks` implements `AutoCloseable`, but `use { }` is
the wrong idiom for it: the instance is meant to live as long as the application, not one block.
Hold one and close it at shutdown — and on Android, tie it to the application rather than to an
`Activity`.

## `BlocksPlatformConfig`

Configuration that applies only to the target the app is built for. Each target declares its own
shape, so a target with nothing to configure has no parameter to misuse rather than a field it
silently ignores — which means `BlocksPlatformConfig` is only constructible with arguments from the
source set where those arguments exist.

Today the JVM is the only target with anything in it.

## Storing the session on the JVM

**A JVM or desktop app has to say where its stored data lives, or its session will not survive a
restart.** Nothing else does: Android lands in the app's own sandbox and iOS in its Keychain access
group, both supplied by the OS. The JVM has neither, and `$HOME` is shared by every process you run
— so a directory the library picked would be shared by every Blocks application on the machine, and
two apps against one backend would hold one session. Rather than guess, the library asks:

```kotlin
// jvmMain / desktopMain
val blocks = Blocks(
    BlocksConfig(
        server = Servers.prod,
        platformConfig = BlocksPlatformConfig(
            storageLocation = { applicationDataDirectory("MyApp") },
        ),
    ),
)
```

`storageLocation` is called on first use rather than at construction, and off the calling thread,
so it may read the environment and create the directory it returns.

**Configure nothing and the session is held in memory for the life of the process.** Calls work and
sign-in works; the session is simply gone on the next launch. There is no error and no warning, so
if sign-in is not surviving a restart, this is why.

### Choosing a directory

The conventional per-OS location, which has no portable form in the JDK:

```kotlin
fun applicationDataDirectory(appName: String): File {
    val home = System.getProperty("user.home")
    val os = System.getProperty("os.name").lowercase()
    val base = when {
        os.startsWith("windows") -> System.getenv("LOCALAPPDATA") ?: "$home\\AppData\\Local"
        os.startsWith("mac") -> "$home/Library/Application Support"
        else -> System.getenv("XDG_DATA_HOME") ?: "$home/.local/share"
    }
    return File(base, appName)
}
```

Copy it rather than reaching for a library helper — there isn't one, deliberately. Roaming versus
local on Windows is your policy, a `jpackage` or Conveyor bundle often carries its own convention,
and a portable install wants its data beside the executable. A helper would have to pick one and
could never change it without silently moving every app's session.

Two applications must not share a directory. That is the whole point of supplying one: the library
cannot tell two apps apart, and a shared directory means a shared session.

### Shared multiplatform code

An `expect`/`actual` keeps the asymmetry in one place — see [`example/kmp`](../example/kmp), whose
desktop target does exactly this:

```kotlin
// commonMain
expect fun platformConfig(): BlocksPlatformConfig
val blocks = Blocks(BlocksConfig(server = Servers.prod, platformConfig = platformConfig()))

// desktopMain — without this, a restart signs the user out
actual fun platformConfig() = BlocksPlatformConfig(
    storageLocation = { applicationDataDirectory("MyApp") },
)

// androidMain and iosMain — the OS already isolates storage per application
actual fun platformConfig() = BlocksPlatformConfig()
```

### Where each target stores it

| Platform | Cookie storage |
|---|---|
| Android | `EncryptedSharedPreferences`, in the app's sandbox |
| iOS | Keychain Services, scoped to the app's access group |
| JVM | AES-256-GCM encrypted files under the directory you supply, or memory if you supply none |

## Signing out

Call the backend's own sign-out — on a generated auth namespace, or `OidcClient.signOut()`. It
revokes the session server-side and expires the cookie as part of its response, so the local copy
goes with it.

There is no public method for clearing stored state locally, and that is deliberate: dropping the
cookie without telling the backend leaves a live session on the server that the user believes is
gone.

## Upgrading from a release that wrote to `~/.blocks`

Versions of this runtime that predate `storageLocation` wrote the cookie jar to `~/.blocks/cookies`,
shared by every Blocks app for the OS user. Those entries are not read and not migrated, so a
signed-in user signs in once more after upgrading. Nothing removes the old directory; delete
`~/.blocks` by hand if you want it gone.
