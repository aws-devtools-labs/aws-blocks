# Android Example App

A native Android app demonstrating the AWS CDK Blocks Kotlin plugin. It uses Jetpack Compose for its UI and exercises several block types against a shared backend spec.

## Features Demonstrated

- **OIDC Authentication** - Sign in/out using configured identity providers
- **Todos** - Create, list, update, and delete todos with sorting and priority
- **KV Store** - Set and get key-value pairs
- **Cookies** - Set, get, and delete cookies via the cookie store
- **Realtime** - Live cursor tracking using the realtime block
- **File Transfer** - Upload and download files using the file bucket block

## Prerequisites

Follow the shared [backend setup](../typescript/README.md#running) to start the backend and generate `cdk-blocks/blocks.spec.json`, which the Gradle plugin reads at build time.

## Configuring OIDC

Sign-in goes through the shared backend's Google provider. The [backend README](../typescript/README.md#configuring-oidc) covers both ways to make it work: the stub IdP, which needs no credentials (a small change in the backend's `cdk-blocks/index.ts`), and a Google OAuth client.

Specific to this app:

- **Local or sandbox:** `MainViewModel` (in `MainActivity.kt`) constructs `Blocks()`, which follows the single server in the spec. Regenerate the spec for the other server and rebuild; no code changes.
- **Emulator:** run `adb reverse tcp:3001 tcp:3001` and keep the spec's `localhost:3001`. Pointing the app at `http://10.0.2.2:3001` produces a redirect URI Google won't register.
- **`relayTo` scheme:** needs no manual registration. The plugin injects it into the merged manifest.

## Running

1. Open this directory in Android Studio.
2. Sync Gradle and run the `app` configuration on an emulator or device.

## Project Structure

```
app/src/main/java/com/aws/blocks/example/
  MainActivity.kt       - Main activity with Compose UI sections
  CursorTracker.kt      - Realtime cursor tracking demo
  FileTransfer.kt       - File upload/download demo
  ui/theme/             - Material 3 theme configuration
```

## Plugin Configuration

The app applies the `com.aws.blocks.kotlin` plugin and configures it in `app/build.gradle.kts`:

```kotlin
cdkBlocks {
    apiSpec = rootProject.file("../typescript/cdk-blocks/blocks.spec.json")
    packageName = "blocks.testapp"
    oidc {
        relayTo = "blocks.testapp://oidcRedirect"
    }
}
```
