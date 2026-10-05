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

When a method returns a transferable whose tag has no runtime binding, the generated client returns `UnknownTransferable`, a carrier for the raw `tag` and `descriptor`, instead of failing code generation. This covers a bare direct result only; an unbound tag wrapped in a nullable, list, or nested type still fails code generation.

## Signing In with OIDC

```kotlin
val auth = AuthApi()
val client = auth.getClient()
val user = client.signIn("google")
```

On the JVM target the system browser is left open on a loopback address once sign-in finishes,
so the runtime serves a page there. By default that is a built-in styled page. An app can
replace it per outcome, from a JVM source set:

```kotlin
client.signIn(
    provider = "google",
    options = OidcSignInOptions(
        OidcSignInPlatformOptions(
            // Send the browser to your own page, so the user ends on a real domain.
            successPage = OidcLandingPage.Redirect("https://app.example.com/signed-in"),
            // Or serve your own markup, with nothing to host.
            errorPage = OidcLandingPage.Html(myLocalizedFailurePage),
        ),
    ),
)
```

`OidcSignInPlatformOptions` has a different shape on each target, so it is only constructible
where it applies — from `jvmMain` or `desktopMain`, not from `commonMain`. Shared code that
calls `signIn(provider)` with no options needs no platform code and gets the built-in pages.

| `OidcLandingPage` | Effect |
|---|---|
| `BuiltIn` (default) | The runtime's own page. The failure variant shows the provider's error, HTML-escaped. |
| `Redirect(url)` | A 302 to `url`. Requires `https`, except on a loopback host for local development. |
| `Html(document)` | `document` served verbatim. Must be a complete HTML document. |

A `Redirect` is sent a clean URL: the callback query is dropped on success, so the
authorization code and `state` are not appended to it, and on failure only `error` and
`error_description` are. An `Html` page receives nothing, so use `Redirect` if you need the
provider's reason.

`BuiltIn` and `Html` are served as the response to the callback itself, so the callback query
stays in the address bar and in `document.location` while that page is open. Markup you supply
through `Html` can therefore read the authorization code; prefer `Redirect` if the page runs
anything you would not want to see it, such as third-party analytics.

Android and iOS have no options to set — their in-app browser dismisses itself.

Bringing your window to the front after sign-in is the app's job; `signIn` returning is the
signal.

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
