# AWS Blocks Kotlin

[![Maven Central](https://img.shields.io/maven-central/v/com.aws.blocks.kotlin/runtime)](https://central.sonatype.com/search?namespace=com.aws.blocks.kotlin)
[![Kotlin](https://img.shields.io/badge/kotlin-2.2.10-blue.svg?logo=kotlin)](https://kotlinlang.org)
![Android](http://img.shields.io/badge/platform-android-6EDB8D.svg?style=flat)
![iOS](http://img.shields.io/badge/platform-ios-CDCDCD.svg?style=flat)
![Desktop](http://img.shields.io/badge/platform-desktop-DB413D.svg?style=flat)

A Gradle plugin and Kotlin Multiplatform runtime that generates type-safe client code from an AWS Blocks spec. It parses your spec at build time and produces Kotlin interfaces, data classes, and a suspending client implementation that calls your backend methods with full type safety across Android, iOS, and JVM.

## Quick Start

### 1. Apply the plugin

In your app module's `build.gradle.kts`:

```kotlin
plugins {
    id("com.aws.blocks.kotlin") version "<version>"
}
```

### 2. Add the runtime dependency

```kotlin
dependencies {
    implementation("com.aws.blocks.kotlin:runtime:<version>")
}
```

### 3. Point at your spec

```kotlin
awsBlocks {
    apiSpec = rootProject.file("aws-blocks/blocks.spec.json")
    packageName = "com.example.myapp.generated"
}
```

Both default — `rootProject.file("blocks.spec.json")` and `com.aws.blocks.generated` — so a project
that matches those can skip this. Every other property, including server URLs and OIDC setup, is in
the [Gradle plugin reference](docs/gradle-plugin.md).

### 4. Call your backend

Codegen runs as part of compilation, so building the module is all it takes to get the client.

```kotlin
import com.aws.blocks.kotlin.Blocks
import com.example.myapp.generated.Api.ListTodos
import com.example.myapp.generated.Api.UpdateTodo
import com.example.myapp.generated.Todo
import com.example.myapp.generated.api
import com.example.myapp.generated.authApi
import com.example.myapp.generated.invoke

val blocks = Blocks()

suspend fun todos() {
    // Create a todo
    val todo: Todo = blocks.api.createTodo(title = "Buy groceries", priority = 1.0)

    // List todos with optional sorting
    val todos: List<Todo> = blocks.api.listTodos(sortBy = ListTodos.SortBy.Priority)

    // Update a todo
    blocks.api.updateTodo(todoId = todo.todoId, updates = UpdateTodo.Updates(completed = true))

    // A second namespace in the same spec
    val authState = blocks.authApi.getAuthState()
}
```

`Blocks()` follows the spec's first server, so regenerating against a different backend leaves the
call site alone — the `invoke` import is what brings it into scope, and without it the compiler
reports a missing `server` argument. Name a server to pin one: `Blocks(Servers.sandbox)`.

Every RPC call and every OIDC client share the one HTTP engine the instance owns; file handles and
realtime channels still open their own. `close()` shuts that engine down, after which calls through
the instance report it rather than failing inside the HTTP client.

> **On JVM and desktop, tell the client where to keep its session.** Without a `storageLocation` it
> holds cookies in memory and the user signs in again on every launch, with no warning. One line —
> see [runtime configuration](docs/runtime-configuration.md#storing-the-session-on-the-jvm).

## Documentation

| Guide | Covers |
|---|---|
| [Gradle plugin](docs/gradle-plugin.md) | the full `awsBlocks { }` block, tasks, and multi-module setups |
| [Runtime configuration](docs/runtime-configuration.md) | `BlocksConfig`, per-target configuration, where the session is stored, signing out |
| [OIDC](docs/oidc.md) | sign-in, relay scheme registration, JVM landing pages, typed providers |
| [Transferables](docs/transferables.md) | results that are live objects rather than data |

## Example apps

See [`example/android`](example/android) for a complete Android app, or [`example/kmp`](example/kmp)
for a Kotlin Multiplatform (Compose) app that uses the plugin with a todo + auth API across Android,
iOS and desktop.

## Supported Platforms

| Platform | Engine | Cookie Storage |
|----------|--------|----------------|
| Android | OkHttp | EncryptedSharedPreferences, in the app's sandbox |
| iOS | Darwin (URLSession) | Keychain Services, scoped to the app |
| JVM | OkHttp | AES-256-GCM encrypted files, in a [directory you supply](docs/runtime-configuration.md#storing-the-session-on-the-jvm) — in memory if you supply none |

## Support by Target

| Block       | Android | iOS | JVM |
|-------------|---------|-----|-----|
| General/RPC | ✅ | ✅ | ✅ |
| Realtime    | ✅ | ✅ | ✅ |
| File Bucket | ✅ | ✅ | ✅ |
| OIDC        | ✅ | ✅ | ✅ |

## Requirements

- Kotlin 2.1+
- JDK 17+
- Gradle 7.4+
- Android Gradle Plugin 7.1+ (for Android targets)

## License

This project is licensed under the Apache License 2.0. See [LICENSE](../../LICENSE) for details.
