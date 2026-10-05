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

## Configuration

All properties are optional. Override them in the `awsBlocks` block if the defaults don't fit your project:

```kotlin
import com.aws.blocks.plugin.GeneratedVisibility

awsBlocks {
    // Path to the generated spec file (defaults to rootProject.file("blocks.spec.json"))
    apiSpec = rootProject.file("path/to/your/blocks.spec.json")

    // Package name for generated code (defaults to "com.aws.blocks.generated")
    packageName = "com.example.myapp.generated"

    // Visibility of generated types: Public (default) or Internal
    visibility = GeneratedVisibility.Internal

    // Override or add server URLs (optional)
    servers {
        local("http://10.0.2.2:3001")
        sandbox("https://sandbox.example.com")
        prod("https://api.example.com")
        custom("staging", "https://staging.example.com")
    }

    // Only needed to use the OIDC client on Android or iOS, where the relay scheme is
    // registered with the operating system. Must match an entry in the backend's
    // allowedRelayOrigins. JVM binds a loopback address per sign-in and ignores this.
    oidc {
        relayTo = "com.yourcompany.yourapp://auth/callback"
    }
}
```

Servers defined in the `servers` block override entries from the spec file that share the same name. New names are added alongside the spec's servers.

On iOS, declare the same `relayTo` scheme in the app's `Info.plist` under `CFBundleURLTypes` — the Gradle plugin cannot reach an Xcode project. Android needs nothing further; the plugin injects the scheme into the merged manifest.

## Using the Generated Code

`Blocks` is the entry point. Construct one with a server from the generated `Servers` object, and
reach each API in the spec through the extension property code generation adds for it.

```kotlin
import com.aws.blocks.kotlin.Blocks
import com.example.myapp.generated.Servers
import com.example.myapp.generated.Todo
import com.example.myapp.generated.api
import com.example.myapp.generated.authApi

val blocks = Blocks(Servers.local)

// Create a todo
val todo: Todo = blocks.api.createTodo(title = "Buy groceries", priority = 1.0)

// List todos with optional sorting
val todos: List<Todo> = blocks.api.listTodos(sortBy = ListTodos.SortBy.Priority)

// Update a todo
blocks.api.updateTodo(todoId = todo.todoId, updates = UpdateTodo.Updates(completed = true))

// A second namespace in the same spec, on the one HTTP client the instance owns
val user = blocks.authApi.getCurrentUser()
```

One instance holds one HTTP client and connection pool for every API in the spec, so build one and
hold it for as long as the backend is in use. It is an `AutoCloseable`: `close()` shuts the client
down, and work scoped to a block can use `Blocks(Servers.local).use { ... }`.

The API objects those properties return are stateless wrappers over that client, so reading one
twice is as cheap as holding it — `blocks.api.listTodos()` on each call is fine.

When a method returns a transferable whose tag has no runtime binding, the generated client returns `UnknownTransferable`, a carrier for the raw `tag` and `descriptor`, instead of failing code generation. This covers a bare direct result only; an unbound tag wrapped in a nullable, list, or nested type still fails code generation.

## Gradle Tasks

| Task | Description |
|------|-------------|
| `awsBlocksCodegen<Variant>` | Generates Kotlin sources for the given Android variant (e.g. `awsBlocksCodegenDebug`) |
| `awsBlocksCodegen` | Generates Kotlin sources (KMP projects: into `commonMain`, JVM projects: into `main`) |
| `awsBlocksDumpModel` | Parses the spec and dumps the intermediate model for debugging |

## Example

See the [`example/android`](example/android) directory for a complete Android app, or [`example/kmp`](example/kmp) for a Kotlin Multiplatform (Compose) app that uses the plugin with a todo + auth API.

## Supported Platforms

| Platform | Engine | Cookie Storage |
|----------|--------|----------------|
| Android | OkHttp | EncryptedSharedPreferences |
| iOS | Darwin (URLSession) | Keychain Services |
| JVM | OkHttp | AES-256-GCM encrypted files |

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
