# Kotlin Multiplatform Example App

A Compose Multiplatform app demonstrating the AWS Blocks Kotlin plugin across Android, iOS, and Desktop (JVM) targets. It uses a shared UI written in Compose with platform-specific entry points.

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

From the `example/typescript/aws-blocks` directory, run the following to start the backend and generate the spec file:

```bash
npm install
npm run dev
npx blocks-generate-spec
```

This produces the `blocks.spec.json` file that the Gradle plugin reads at build time.

## Configuring OIDC

Sign-in goes through the shared backend's Google provider, which needs a real OAuth client — there is no fake-user fallback, so the Auth tab reports `ProviderNotConfigured` until it is set up. Creating the client in Google Cloud Console and providing its client ID and secret to a local or sandbox backend is covered in the [backend README](../typescript/README.md#configuring-oidc).

Three things are specific to this app:

- **Switching between local and sandbox needs no code change.** The spec carries a single server, and the generated `Api()` / `AuthApi()` constructors default to it. Re-run `npm run dev` or `npm run sandbox`, regenerate the spec, and rebuild.
- **The same OAuth client serves all three targets.** The client derives the OAuth redirect URI from the server it is pointed at, not from the platform, so one registered URI per environment covers Android, iOS, and desktop.
- **On the Android emulator, forward the port rather than rewriting the host.** Google only accepts `http://` redirect URIs on `localhost` / `127.0.0.1`, so keep the spec's `localhost:3001` and run `adb reverse tcp:3001 tcp:3001`; pointing the app at `http://10.0.2.2:3001` instead produces a redirect URI Google won't register. The iOS simulator and desktop reach `localhost` directly.

Registering the `relayTo` scheme the backend redirects to after sign-in is per-platform — see [Plugin Configuration](#plugin-configuration).

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
awsBlocks {
    apiSpec = rootProject.file("../typescript/aws-blocks/blocks.spec.json")
    packageName = "blocks.testapp"
    oidc {
        relayTo = "blocks.testapp://oidcRedirect"
    }
}
```

The plugin generates type-safe API client code into `commonMain`, making the generated `Api`, `AuthApi`, and model classes available to all platforms.

The `relayTo` scheme is registered per platform: the plugin injects it into the Android manifest, `iosApp/iosApp/Info.plist` declares it under `CFBundleURLTypes`, and desktop needs no registration because it receives the redirect on a loopback address it binds per sign-in.
