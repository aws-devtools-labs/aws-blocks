# blocks_runtime

Runtime library for the Blocks Dart SDK. Provides a JSON-RPC 2.0 HTTP client, WebSocket realtime channels, file upload/download handles, cookie-based session management, and OIDC authentication (PKCE + token exchange).

## Usage

```dart
import 'package:blocks_runtime/blocks_runtime.dart';
```

This package is used by generated client code produced by `blocks_codegen`. You typically don't interact with it directly.

## Typed OIDC providers

`OidcClient`'s `signIn`, `signInRelay` and `exchange` take a provider by the name the backend knows it by. `TypedOidcClient<P extends OidcProvider>` is an extension type over an `OidcClient` that narrows those three methods to providers of type `P`. A generated client returns one, with `P` an enum it generates from the spec's provider names, so passing a provider that client doesn't have is a compile error:

```dart
// AuthApiGetClientProvider is the enum blocks_codegen generates for a
// method `auth.getClient` whose spec names its providers.
final TypedOidcClient<AuthApiGetClientProvider> oidc =
    await blocks.auth.getClient();
await oidc.signInRelay(
  AuthApiGetClientProvider.google,
  launcher: launcher,
  relayTo: 'com.example.app://auth',
);
```

It costs nothing at runtime: it is the same object as the `OidcClient` it wraps, so it can be passed wherever an `OidcClient` is expected, and its other members are the client's own. Typed as an `OidcClient`, it takes provider names again. Because it is a compile-time view, `is TypedOidcClient` can't tell it from a plain `OidcClient` at runtime.

## User-agent attribution

Outbound requests carry an `aws-blocks-dart` token so AWS telemetry can attribute traffic.

On web the token is dropped on every path. The RPC hop omits `x-blocks-user-agent` because the header is non-safelisted, so a browser can only send it once the server adds `x-blocks-user-agent` to its CORS allowlist.

The presigned upload and download set `User-Agent`, which browsers ignore because it is a forbidden header name. The WebSocket upgrade omits it because browsers do not allow custom headers on the upgrade request.

## License

Apache 2.0
