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

When a method returns a transferable whose tag has no runtime binding, the generated client returns `UnknownTransferable`, a carrier for the raw `tag` and `descriptor`, instead of failing code generation. Only bare direct results are covered; a nullable result still fails code generation.

A transferable the runtime binds (a realtime channel, a file handle, an OIDC client) hydrates into its live object wherever it appears: returned directly, inside a list or map, in a property of a model, or in the messages of a realtime channel (`RealtimeChannel<List<FileDownloadHandle>>`, or a channel whose message model holds one). An OIDC client needs the calling client and the configured `oidc { relayTo }`, so a model that holds one decodes through its generated operation; to decode one yourself, use `OidcClient.json(blocksClient, relayTo).decodeFromJsonElement<LoginMenu>(json)`. A transferable is sent back as its `{ "__blocks": … }` descriptor (its `toJson()`), so an operation can take one as a parameter, directly, in a list or map, or in a model (a model holding an OIDC client encodes with `OidcClient.json`, as the generated operation does).

A schema with both `properties` and `additionalProperties` (TypeScript `T & Record<string, V>`) generates a class whose known properties are typed and whose `attributes: Map<String, V>` holds every other key. Those keys are flat on the wire, next to the properties, in both directions. For example, the `signUp` action of an `Auth` block's `createApi()` takes custom attributes this way; with `export const authApi = auth.createApi()`, `AuthApi.SetAuthState.Input.SignUp(username, password, attributes = mapOf("email" to email))` sends `{"action":"signUp","username":…,"password":…,"email":…}`. An `attributes` entry named like a property, or like the union's discriminator, isn't sent: the property wins. If the schema has a property named `attributes` itself, that property keeps the name and the map is `attributes_2`.

A union (`anyOf` / `oneOf`) generates a sealed class with one subclass per arm, read and written in the spec's wire format. When every arm is an object with a string discriminator property, the subclasses are written with that property (`{"type":"email",…}`). Otherwise each value is its arm's bare JSON value: a string, number, boolean, array, map, date-time or transferable arm is a subclass holding it as `value` (`Search.Query.Variant1("abc")` is sent as `"abc"`), a `const` arm is a `data object` written as its literal, and an object arm is its object, with no extra key. A value decodes to the first arm, in spec order, whose JSON shape it has (its JSON type, its required keys, or its exact literal), and one that matches no arm throws a `SerializationException` naming the union. A boolean or numeric discriminator is written and matched with that JSON type (`"isUpdated": true`). An arm with its own properties plus a nested `oneOf` (the `confirmSignIn` action of an `Auth` block's `createApi()`) is one flat object: `ConfirmSignIn(session, challenge = Challenge.Code(code))` sends `{"action":"confirmSignIn","session":…,"challenge":"code","code":…}`.

Generated names follow the spec, and the wire keeps the spec's names. A property, parameter or operation keeps its spec name, escaped with backticks where Kotlin needs it (`` `class` ``, `` `content-type` ``). A name Kotlin can't declare even in backticks (one holding `.`, `;`, `[`, `]`, `/`, `<`, `>`, `:`, `\`, a backtick or a control character such as a line break) becomes its words in camelCase: a key `back\slash` is the property `backSlash` with `@SerialName("back\\slash")`, and the method `a.b.ping` is `A.bPing()`, which still calls `a.b.ping`. Types, enum constants and union subclasses are PascalCase. When two names land on one Kotlin name in the same scope (properties `user_name` and `userName` with inline object types, enum values `in-progress` and `in_progress`), the first keeps it and the next gets `_2`, then `_3`, and so on; so does a nested type named like a property of its class (`Meta: Meta_2`). Generated names step aside for yours: an operation with a parameter named `client`, `request`, `args`, `result` or `json` keeps that parameter name, and the generated code around it adapts.

## Signing In With `Auth`

An AWS Blocks `Auth` block serves its OIDC sign-in routes at fixed paths, so the OIDC client is built from the server and the provider ids, with no backend call:

```kotlin
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.oidc.OidcClient
import com.example.myapp.generated.Servers

val oidc = OidcClient.forAuth(
    BlocksClient(Servers.local),
    providers = listOf("google"), // the keys of the backend's oidcProviders
    relayTo = "com.yourcompany.yourapp://auth/callback", // as in oidc { relayTo } above
)

val user = oidc.signIn("google") // opens the browser; oidc.authState follows along
oidc.signOut()
```

Sign-in stores the backend's session cookie, which every generated API client sends, so methods the backend gates with `requireAuth` work after it. If the backend moves its routes with `redirects.callbackPath`, pass that path's directory as `basePath`.

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
