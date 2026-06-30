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
        redirectUrl = "blocks.testapp://oidcRedirect"
    }
}
```

The plugin generates type-safe API client code at build time, producing the `Api`, `AuthApi`, and model classes used throughout the app.
