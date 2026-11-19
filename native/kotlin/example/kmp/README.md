# Kotlin Multiplatform Example App

A Compose Multiplatform app demonstrating the AWS CDK Blocks Kotlin plugin across Android, iOS, and Desktop (JVM) targets. It uses a shared UI written in Compose with platform-specific entry points.

## Features Demonstrated

- **Authentication** - Sign in/out using configured identity providers
- **Todos** - Create, list, update, and delete todos
- **KV Store** - Set and get key-value pairs
- **Realtime** - Live updates using the realtime block
- **Files** - Upload and download files using the file bucket block

## Supported Platforms

| Platform | Entry Point |
|----------|-------------|
| Android  | `composeApp/src/androidMain` |
| iOS      | `iosApp/` (Swift + Compose framework) |
| Desktop  | `composeApp/src/desktopMain` |

## Prerequisites

Follow the shared [backend setup](../typescript/README.md#running) to start the backend and generate `cdk-blocks/blocks.spec.json`, which the Gradle plugin reads at build time.

## Configuring OIDC

Sign-in goes through the shared backend's Google provider. The [backend README](../typescript/README.md#configuring-oidc) covers both ways to make it work: the stub IdP, which needs no credentials (a small change in the backend's `cdk-blocks/index.ts`), and a Google OAuth client.

Specific to this app:

- **Local or sandbox:** `App` constructs `Blocks` with `Blocks.defaultServer`, the single server in the spec. Regenerate the spec for the other server and rebuild; no code changes.
- **One OAuth client serves all three targets.** The client derives the OAuth redirect URI from the server it is pointed at, not from the platform, so one registered URI per environment covers Android, iOS, and desktop.
- **Android emulator:** run `adb reverse tcp:3001 tcp:3001` and keep the spec's `localhost:3001`. Pointing the app at `http://10.0.2.2:3001` produces a redirect URI Google won't register. The iOS simulator and desktop reach `localhost` directly.
- **`relayTo` scheme:** registered per platform; see [Plugin Configuration](#plugin-configuration).

## Running

Open this directory in IntelliJ IDEA or Android Studio (with the [KMP plugin](https://plugins.jetbrains.com/plugin/14936-kotlin-multiplatform) installed) and run the relevant target.

## Project Structure

```
composeApp/src/
  commonMain/       - Shared UI and logic (App.kt, screens/, theme/)
  androidMain/      - Android activity entry point
  iosMain/          - iOS MainViewController
  desktopMain/      - Desktop main() entry point
iosApp/             - Xcode project that hosts the Compose framework
```

## Plugin Configuration

The app applies the `com.aws.blocks.kotlin` plugin in `composeApp/build.gradle.kts`:

```kotlin
cdkBlocks {
    apiSpec = rootProject.file("../typescript/cdk-blocks/blocks.spec.json")
    packageName = "blocks.testapp"
    oidc {
        relayTo = "blocks.testapp://oidcRedirect"
    }
}
```

The plugin generates type-safe API client code into `commonMain`, making the generated `Api`, `AuthApi`, and model classes available to all platforms.

The `relayTo` scheme is registered per platform: the plugin injects it into the Android manifest, `iosApp/iosApp/Info.plist` declares it under `CFBundleURLTypes`, and desktop needs no registration because it receives the redirect on a loopback address it binds per sign-in.
