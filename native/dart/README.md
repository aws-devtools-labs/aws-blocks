# AWS Blocks Dart

The Dart SDK for AWS Blocks.

AWS Blocks lets you define a backend in TypeScript — APIs, auth, databases, realtime channels, file storage — and deploy it to AWS. This SDK gives your Flutter app a typed client that talks to that backend with zero boilerplate.

## How it works

You write your backend. AWS Blocks generates a spec file describing your API. This SDK reads that spec and produces a Dart client with typed methods, models, and realtime subscriptions — ready to drop into your Flutter app.

```
Your backend (TypeScript)  →  blocks.spec.json  →  blocks_codegen  →  Typed Dart client
```

## What you get

```dart
final blocks = Blocks(baseUrl: 'https://your-api.example.com');

// Call your API methods with full type safety
final todo = await blocks.api.createTodo(title: 'Buy milk', priority: 1);
final todos = await blocks.api.listTodos(sortBy: SortBy.priority);

// Auth flows with exhaustive variants
await blocks.authApi.setAuthState(
  input: SignInInput(username: 'alice', password: 'secret'),
);

// Realtime — subscribe to live data over WebSocket
final channel = await blocks.api.getCursorChannel();
channel.subscribe().listen((cursor) {
  print('${cursor.userId} moved to (${cursor.x}, ${cursor.y})');
});
```

## Packages

| Package | Role |
|---------|------|
| **blocks_runtime** | The runtime your app ships with — HTTP client, WebSocket realtime, file handles |
| **blocks_codegen** | The code generator — reads your spec, outputs Dart. Only runs at build time. |

## Getting started

### 1. Add dependencies

```yaml
# pubspec.yaml
dependencies:
  blocks_runtime: ^1.0.0

dev_dependencies:
  blocks_codegen: ^1.0.0
  build_runner: ^2.4.0
```

### 2. Add your spec and configure the builder

Drop your `blocks.spec.json` into `lib/`, then create a `build.yaml`:

```yaml
targets:
  $default:
    builders:
      blocks_codegen|blocks_codegen:
        options:
          spec: lib/blocks.spec.json
          # Logical identities from x-blocks-native-packages that keep the
          # UnknownTransferable fallback instead of a declared type (optional).
          # An identity the spec does not declare only warns, as AWSBLOCKS-NATIVE-006
          native_package_opt_out:
            - example-iot-native
```

### 3. Generate your client

```bash
dart run build_runner build
```

This produces a typed Dart client from your spec.

### 4. Use it

```dart
import 'package:blocks_runtime/blocks_runtime.dart';
import 'blocks.blocks.dart';

final blocks = Blocks(baseUrl: 'http://localhost:3001/aws-blocks/api');
final greeting = await blocks.hello.greet(name: 'World');
print(greeting.message); // "Hello, World!"
```

## Features

**Type-safe API calls** — every method, parameter, and return type is generated from your spec. Typos and type mismatches are caught at compile time.

**Realtime subscriptions** — if your backend has realtime channels (e.g., cursor tracking, live updates), the generated client gives you typed `Stream<T>` subscriptions over WebSocket.

**Auth flows** — discriminated unions become sealed classes. The compiler ensures you handle every auth state variant.

**File transfers** — presigned upload/download URLs are wrapped in handle objects with simple `.upload(bytes)` / `.download()` methods.

**Unbound transferables** — a direct result with an unbound transferable tag returns `UnknownTransferable`, a carrier for the raw `tag` and `descriptor`, instead of untyped `dynamic`. Only bare direct results are covered.

**Declared native packages** — when `x-blocks-native-bindings` binds the tag and its package has a `dart` field, the client imports the declared library and returns that type via `<Type>.fromBlocksDescriptor`. See [the schema generation guide](../../docs/native-clients/schema-generation-guide-for-devs.md#x-blocks-native-bindings-document-root).

**Errors and HTTP status** — a JSON-RPC error is thrown as a `BlocksRpcException` (with `code` and `data`) whatever the HTTP status, so a backend namespace created with `httpErrorStatus: true` (which answers a 4xx `ApiError` with that HTTP status) decodes the same. One difference to plan for: when the client has an `authProvider` (bearer tokens), any HTTP 401 makes it call `onAuthFailure()` (a token refresh) and run the method **once more**. Without `httpErrorStatus` an `ApiError` 401 arrives as HTTP 200 and is not retried; with it, a method that rejects with 401 after a side effect runs twice, so put the guard first on the backend: call `auth.requireAuth(context)` before anything else in the method, or wrap the method with `auth.protect` (`Auth`), which runs the guard before any of the method's code. A method that can still answer 401 after a write should be idempotent.

**No Flutter dependency** — `blocks_runtime` is pure Dart. Works in CLI apps, server-side Dart, or Flutter.

## Project structure

```
native/dart/
├── packages/
│   ├── blocks_runtime/          # Runtime library (ships with your app)
│   ├── blocks_codegen/          # Code generator (build-time only)
│   └── blocks_runtime_flutter/  # Flutter integration (secure storage, browser launcher)
├── example/                     # Demo Flutter app with auth, todos, realtime cursors
└── README.md
```

## Requirements

- Dart 3.3+
- Flutter (for the demo app — the SDK itself is pure Dart)
- Node.js 22+ (for running the AWS Blocks backend locally)

## How the codegen works

The generator has three stages:

1. **Parse** — reads the OpenRPC JSON spec, extracts methods, schemas, and type relationships
2. **Build** — resolves types, deduplicates identical shapes, groups methods into namespaces
3. **Generate** — outputs Dart source with data classes, sealed hierarchies, API methods, and a `Blocks` facade

The output is a single self-contained `.blocks.dart` file. For backends with realtime or file features, it also imports `blocks_runtime` for WebSocket and presigned URL support.

## License

Apache-2.0
