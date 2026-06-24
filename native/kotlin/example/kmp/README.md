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
}
```

The plugin generates type-safe API client code into `commonMain`, making the generated `Api`, `AuthApi`, and model classes available to all platforms.
