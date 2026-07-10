# AWS Blocks Kotlin

[![Maven Central](https://img.shields.io/maven-central/v/com.aws.blocks.kotlin/runtime)](https://central.sonatype.com/search?namespace=com.aws.blocks.kotlin)
[![Kotlin](https://img.shields.io/badge/kotlin-2.1.21-blue.svg?logo=kotlin)](https://kotlinlang.org)
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
}
```

Servers defined in the `servers` block override entries from the spec file that share the same name. New names are added alongside the spec's servers.

## Using the Generated Code

```kotlin
import com.example.myapp.generated.Api
import com.example.myapp.generated.Todo

val api = Api()

// Create a todo
val todo: Todo = api.createTodo(title = "Buy groceries", priority = 1.0)

// List todos with optional sorting
val todos: List<Todo> = api.listTodos(sortBy = ListTodos.SortBy.Priority)

// Update a todo
api.updateTodo(todoId = todo.todoId, updates = UpdateTodo.Updates(completed = true))
```

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
| OIDC        | ✅ | ❌ | ❌ |

## Requirements

- Kotlin 2.x
- JDK 17+
- Gradle 7.4+
- Android Gradle Plugin 7.1+ (for Android targets)

## License

This project is licensed under the Apache License 2.0. See [LICENSE](../../LICENSE) for details.
