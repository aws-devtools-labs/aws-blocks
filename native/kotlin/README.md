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
    apiSpec = rootProject.file("aws-blocks/blocks.spec.json") // default: rootProject.file("blocks.spec.json")
    packageName = "com.example.myapp.generated" // default: "com.aws.blocks.generated"
}
```

See the [Gradle plugin reference](docs/gradle-plugin.md) for full configuration options.

### 4. Call your backend

Codegen runs as part of compilation, so building the module is all it takes to get the client.

```kotlin
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

Building the instance — which server it reaches, the imports the generated accessors need, and
closing the engine it owns — is covered in
[runtime configuration](docs/runtime-configuration.md#building-an-instance).

> **On JVM and desktop, give the client an [`applicationId`](docs/runtime-configuration.md#identifying-your-application)** — without one it keeps the session in memory and the user signs in again on every launch, with no warning.

## Generated types

A schema with both `properties` and `additionalProperties` (TypeScript `T & Record<string, V>`) generates a class whose known properties are typed and whose `attributes: Map<String, V>` holds every other key. Those keys are flat on the wire, next to the properties, in both directions. For example, the `signUp` action of an `Auth` block's `createApi()` takes custom attributes this way; with `export const authApi = auth.createApi()`, `AuthApi.SetAuthState.Input.SignUp(username, password, attributes = mapOf("email" to email))` sends `{"action":"signUp","username":…,"password":…,"email":…}`. An `attributes` entry named like a property, or like the union's discriminator, isn't sent: the property wins. If the schema has a property named `attributes` itself, that property keeps the name and the map is `attributes_2`.

A union (`anyOf` / `oneOf`) generates a sealed class with one subclass per arm, read and written in the spec's wire format. When every arm is an object with a string discriminator property, the subclasses are written with that property (`{"type":"email",…}`). Otherwise each value is its arm's bare JSON value: a string, number, boolean, array, map, date-time or transferable arm is a subclass holding it as `value` (`Search.Query.Variant1("abc")` is sent as `"abc"`), a `const` arm is a `data object` written as its literal, and an object arm is its object, with no extra key. A value decodes to the first arm, in spec order, whose JSON shape it has (its JSON type, its required keys, or its exact literal), and one that matches no arm throws a `SerializationException` naming the union. A boolean or numeric discriminator is written and matched with that JSON type (`"isUpdated": true`). An arm with its own properties plus a nested `oneOf` (the `confirmSignIn` action of an `Auth` block's `createApi()`) is one flat object: `ConfirmSignIn(session, challenge = Challenge.Code(code))` sends `{"action":"confirmSignIn","session":…,"challenge":"code","code":…}`.

Generated names follow the spec, and the wire keeps the spec's names. A property, parameter or operation keeps its spec name, escaped with backticks where Kotlin needs it (`` `class` ``, `` `content-type` ``). A name Kotlin can't declare even in backticks (one holding `.`, `;`, `[`, `]`, `/`, `<`, `>`, `:`, `\`, a backtick or a control character such as a line break) becomes its words in camelCase: a key `back\slash` is the property `backSlash` with `@SerialName("back\\slash")`, and the method `a.b.ping` is `A.bPing()`, which still calls `a.b.ping`. Types, enum constants and union subclasses are PascalCase. When two names land on one Kotlin name in the same scope (properties `user_name` and `userName` with inline object types, discriminator values `in-progress` and `in_progress`), the first keeps it and the next gets `_2`, then `_3`, and so on; so does a nested type named like a property of its class (`Meta: Meta_2`). Enum constants that meet are numbered without the underscore (`InProgress`, `InProgress2`). Generated names step aside for yours: an operation with a parameter named `client`, `request`, `args`, `result` or `json` keeps that parameter name, and the generated code around it adapts.

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

| Platform | Engine | Cookie Storage                                                                                                          |
|----------|--------|-------------------------------------------------------------------------------------------------------------------------|
| Android | OkHttp | EncryptedSharedPreferences, in the app's sandbox                                                                        |
| iOS | Darwin (URLSession) | Keychain Services, scoped to the app                                                                                    |
| JVM | OkHttp | AES-256-GCM encrypted files under [`~/.blocks/<applicationId>`](docs/runtime-configuration.md#identifying-your-application) — in memory if no id is set |

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
