# Android Example App

A native Android app demonstrating the AWS Blocks Kotlin plugin. It uses Jetpack Compose for its UI and exercises several block types against a shared backend spec.

## Features Demonstrated

- **OIDC Authentication** - Sign in/out using configured identity providers
- **Todos** - Create, list, update, and delete todos with sorting and priority
- **KV Store** - Set and get key-value pairs
- **Cookies** - Set, get, and delete cookies via the cookie store
- **Realtime** - Live cursor tracking using the realtime block
- **File Transfer** - Upload and download files using the file bucket block

## Prerequisites

From the `example/typescript/aws-blocks` directory, run the following to start the backend and generate the spec file:

```bash
npm install
npm run dev
npx blocks-generate-spec
```

This produces the `blocks.spec.json` file that the Gradle plugin reads at build time.

## Configuring OIDC

Sign-in goes through the shared backend's Google provider, which needs a real OAuth client — there is no fake-user fallback, so the Auth section reports `ProviderNotConfigured` until it is set up. Creating the client in Google Cloud Console and providing its client ID and secret to a local or sandbox backend is covered in the [backend README](../typescript/README.md#configuring-oidc).

Two things are specific to this app:

- **Switching between local and sandbox needs no code change.** The spec carries a single server, and the generated `Api()` / `AuthApi()` constructors default to it. Re-run `npm run dev` or `npm run sandbox`, regenerate the spec, and rebuild.
- **On the emulator, forward the port rather than rewriting the host.** The client derives the OAuth redirect URI from the server it is pointed at, and Google only accepts `http://` redirect URIs on `localhost` / `127.0.0.1`. So keep the spec's `localhost:3001` and run `adb reverse tcp:3001 tcp:3001`; pointing the app at `http://10.0.2.2:3001` instead produces a redirect URI Google won't register.

The `relayTo` scheme the backend redirects to after sign-in needs no manual registration here — the plugin injects it into the merged manifest.

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
awsBlocks {
    apiSpec = rootProject.file("../typescript/aws-blocks/blocks.spec.json")
    packageName = "blocks.testapp"
    oidc {
        relayTo = "blocks.testapp://oidcRedirect"
    }
}
```

The plugin generates type-safe API client code at build time, producing the `Api`, `AuthApi`, and model classes used throughout the app.
