# Demo Apps

This folder contains a TypeScript backend and a Swift iOS app that demonstrates the full end-to-end workflow.

## Features

- **Authentication** — email + password sign-up (confirmed with an emailed code) and sign-in via `Auth`
- **Todo List** — CRUD with priority, sorting by index (DistributedTable)
- **Realtime Cursors** — collaborative cursor tracking (Realtime pub/sub)
- **File Storage** — upload/download via presigned URLs (FileBucket)
- **KV Store** — simple key-value get/set
- **Cookies** — server-side cookie management

## Prerequisites

- Node.js 22+
- Xcode 26+
- iOS Simulator

> **Upgrading a deployed stack:** todos are now keyed on the owner's `userSub` instead of `userId`. A table's key can't change in place, so a stack deployed from an earlier version of this demo fails to update — destroy it (`npm run sandbox:destroy` for a sandbox, `npm run destroy` for a deployed app) and deploy again. Existing todos are not carried over.

## 1. Start the TypeScript Backend

```bash
cd typescript-demo
npm install
npm run dev
```

The server starts at `http://localhost:3001`. It serves the Blocks API (JSON-RPC) and the web frontend. Sign-up sends a verification code; locally no email is sent, and the dev-server console prints the code instead.

## 2. Generate the Spec File

```bash
cd typescript-demo
npm run spec
```

This produces `typescript-demo/aws-blocks/blocks.spec.json`.

## 3. Copy the Spec to the Swift Demo

```bash
cp typescript-demo/aws-blocks/blocks.spec.json swift-demo/blocks.spec.json
```

## 4. Generate Swift Code

### Option A: Direct CLI (fastest)

From `native/swift/`:

```bash
swift run swift-code-generator Demo/typescript-demo/aws-blocks/blocks.spec.json Demo/swift-demo/Generated
```

### Option B: Command Plugin (Xcode)

1. Open `swift-demo/BlocksDemo.xcodeproj` in Xcode
2. Right-click the `aws-blocks-swift` package in the Project Navigator
3. Select "generate-code-from-blocks-spec"
4. Add the `Generated/` folder to your target (first time only)

### Option C: Command Plugin (CLI)

```bash
swift package --allow-writing-to-package-directory generate-code-from-blocks-spec
```

### Option D: Build Plugin (Xcode)

1. Open your project in Xcode
2. Select your target → Build Phases
3. Click "+" → "Run Build Tool Plug-ins"
4. Add `BlocksCodegenBuildPlugin`

Or add it in `Package.swift`:

```swift
.target(
    name: "MyApp",
    dependencies: [.product(name: "BlocksRuntime", package: "aws-blocks-swift")],
    plugins: [.plugin(name: "BlocksCodegenBuildPlugin", package: "aws-blocks-swift")]
)
```

With the build plugin, code is regenerated automatically on every build. No need to add generated files to the project — they compile directly from the plugin output.

## 5. Run the iOS App

1. Open `swift-demo/BlocksDemo.xcodeproj` in Xcode
2. Select an iOS Simulator as the run destination
3. Build and run (Cmd+R)

The app connects to `http://localhost:3001/api` by default. If running on a physical device, update the URL in `App.swift` to your Mac's LAN IP.

## 6. Run Tests

From `native/swift/`:

```bash
swift test
```

## Folder Structure

```
Demo/
├── typescript-demo/          # Backend (Node.js + Blocks)
│   ├── aws-blocks/
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
