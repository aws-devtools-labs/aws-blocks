# Demo Apps

This folder contains a TypeScript backend and a Swift iOS app that demonstrates the full end-to-end workflow.

## Features

- **Authentication** — email + password sign-up (confirmed with an emailed code) and sign-in via `Auth`
- **Todo List** — CRUD with priority, sorting by index (KVStore with a `schema` and a `key`)
- **Realtime Cursors** — collaborative cursor tracking (Realtime pub/sub)
- **File Storage** — upload/download via presigned URLs (FileBucket)
- **KV Store** — simple key-value get/set
- **Cookies** — server-side cookie management

## Prerequisites

- Node.js 22+
- Xcode 26+
- iOS Simulator

## 1. Start the TypeScript Backend

Use the packages from the framework checkout. From the repository root, run `npm ci` and `npm run build`. Skip `npm install` in `typescript-demo`; if you already ran it there, remove that directory's `node_modules` so it does not shadow the checkout's packages.

From `native/swift/Demo`, link the demo's own backend package and start the server:

```bash
cd typescript-demo
mkdir -p node_modules && ln -sfn ../cdk-blocks node_modules/cdk-blocks
npm run dev
```

The AWS CDK Blocks API runs on `http://localhost:3001`. The dev-server console prints sign-up verification codes instead of sending email.

## 2. Generate the Spec File

In a second terminal, from `native/swift/Demo/typescript-demo`, run:

```bash
npm run spec
```

This produces `typescript-demo/cdk-blocks/blocks.spec.json`.

## 3. Copy the Spec to the Swift Demo

From `native/swift/Demo`:

```bash
cp typescript-demo/cdk-blocks/blocks.spec.json swift-demo/blocks.spec.json
```

Only the Xcode plugins in step 4 read this copy. The CLI command reads the spec in `typescript-demo`.

## 4. Generate Swift Code

From `native/swift/`:

```bash
swift run swift-code-generator Demo/typescript-demo/cdk-blocks/blocks.spec.json Demo/swift-demo/Generated
```

The `BlocksDemo` target compiles `swift-demo/Generated/API.swift` and `Models.swift`, which this command writes.

Other ways to generate the code:

- The command plugin, in Xcode: right-click the `BlocksDemo` project in the Project Navigator and choose `generate-code-from-blocks-spec`. It reads `swift-demo/blocks.spec.json` and writes `swift-demo/Generated/`.
  - Choose the project, not the `cdk-blocks-swift` package. Running the command on the package (including from `native/swift/` with `swift package`) writes into its test targets instead of the demo. Those targets already use the build plugin, so compiling both copies breaks the test build.
- The build plugin, which regenerates on every build. The demo does not use it. To switch to it, add `BlocksCodegenBuildPlugin` under the `BlocksDemo` target's Build Phases → Run Build Tool Plug-ins, add `swift-demo/blocks.spec.json` to the target, and remove the `Generated` group from the target, so its two files are not compiled twice.

## 5. Run the iOS App

1. Open `swift-demo/BlocksDemo.xcodeproj` in Xcode
2. Select an iOS Simulator as the run destination
3. Build and run (Cmd+R)

`AppState` builds one `Blocks()` for the app's lifetime; it uses the first server in the spec. To switch backends, repeat steps 2-4. The dev server binds loopback by default, so run the app in the Simulator; a physical device needs a deployed backend: run `npm run deploy`, then `BLOCKS_SPEC_STAGE=production npm run spec` in place of step 2, then steps 3-4.

Use disposable test data only. The demo's shared key-value and file APIs do not require sign-in.

A deployed stack whose todos table is keyed on `userId` cannot be updated in place: destroy it (`npm run sandbox:destroy`, or `npm run destroy` for a deployed app) and deploy again. Its todos are lost.

## 6. Run Tests

From `native/swift/`:

```bash
swift test
```

## Folder Structure

```
Demo/
├── typescript-demo/          # Backend (Node.js + Blocks)
│   ├── cdk-blocks/
│   │   ├── index.ts          # API definitions (Building Blocks)
│   │   └── blocks.spec.json  # Generated OpenRPC spec
│   ├── src/
│   │   └── index.ts          # Web frontend
│   └── package.json
│
└── swift-demo/               # iOS app (SwiftUI)
    ├── App.swift
    ├── Views/
    │   ├── TodoSectionView.swift
    │   ├── CursorTrackingView.swift
    │   ├── FileTransferView.swift
    │   ├── AuthSectionView.swift
    │   ├── CookieTestView.swift
    │   ├── KVStoreTestView.swift
    │   └── RunAllTestsView.swift
    ├── Generated/            # Output of codegen (do not edit)
    │   ├── Models.swift
    │   └── API.swift
    ├── blocks.spec.json      # Copied from typescript-demo
    └── BlocksDemo.xcodeproj
```
