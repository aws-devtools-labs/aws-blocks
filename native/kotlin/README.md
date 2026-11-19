# AWS CDK Blocks Kotlin

[![Maven Central](https://img.shields.io/maven-central/v/com.aws.blocks.kotlin/runtime)](https://central.sonatype.com/search?namespace=com.aws.blocks.kotlin)
![Android](http://img.shields.io/badge/platform-android-6EDB8D.svg?style=flat)
![iOS](http://img.shields.io/badge/platform-ios-CDCDCD.svg?style=flat)
![Desktop](http://img.shields.io/badge/platform-desktop-DB413D.svg?style=flat)

A Gradle plugin and Kotlin Multiplatform runtime that generates type-safe client code from an AWS CDK Blocks spec. It parses your spec at build time and produces Kotlin interfaces, data classes, and a suspending client implementation that calls your backend methods with full type safety across Android, iOS, and JVM.

## Quick Start

### 1. Apply the plugin

In your app module's `build.gradle.kts`:

```kotlin
plugins {
    id("org.jetbrains.kotlin.plugin.serialization") version "<kotlin version>"
    id("com.aws.blocks.kotlin") version "<version>"
}
```

### 2. Add the runtime dependency

```kotlin
dependencies {
    implementation("com.aws.blocks.kotlin:runtime:<version>")
}
```

### 3. Point at your spec

```kotlin
cdkBlocks {
    apiSpec = rootProject.file("cdk-blocks/blocks.spec.json") // default: rootProject.file("blocks.spec.json")
    packageName = "com.example.myapp.generated" // default: "com.aws.blocks.generated"
}
```

See the [Gradle plugin reference](docs/gradle-plugin.md) for full configuration options.

### 4. Call your backend

Codegen runs as part of compilation: build the module to get the client.

```kotlin
val blocks = Blocks()

suspend fun todos() {
    // Create a todo
    val todo: Todo = blocks.api.createTodo(title = "Buy groceries", priority = 1.0)

    // List todos with optional sorting
    val todos: List<Todo> = blocks.api.listTodos(sortBy = ListTodos.SortBy.Priority)

    // Update a todo
    blocks.api.updateTodo(todoId = todo.todoId, updates = UpdateTodo.Updates(completed = true))

    // A second namespace in the same spec
    val authState = blocks.authApi.getAuthState()
}
```

Building the instance — which server it reaches, the imports the generated accessors need, and
closing the engine it owns — is covered in
[runtime configuration](docs/runtime-configuration.md#building-an-instance).

> **On JVM and desktop, give the client an [`applicationId`](docs/runtime-configuration.md#identifying-your-application)** — without one it keeps the session in memory and the user signs in again on every launch, with no warning.

## Using Auth

An AWS CDK Blocks `Auth` block exposes its sign-in flow as a state machine (`export const authApi =
auth.createApi()` in the backend). `getAuthState()` reports the current state and the actions
available from it; the app renders those actions and submits each one through `setAuthState`. A
block with federated providers also exports its OIDC client (`export const oidcAuthApi =
auth.createOidcApi()`), and the federated sign-in buttons come from that client, not from the
state machine:

```kotlin
val blocks = Blocks(BlocksConfig(server = Blocks.defaultServer, applicationId = "com.example.myapp"))
val oidc = blocks.oidcAuthApi.getClient() // keep it for the app's lifetime

// On launch: getAuthState() reports a session from an earlier launch, for every Auth block.
var state = blocks.authApi.getAuthState()

// One button per federated provider the client can sign in with. `entries` is what the spec named;
// `oidc.providers` is what the backend serves now, so show the ones both agree on.
OidcAuthApi.GetClient.Provider.entries
    .filter { it.providerName in oidc.providers }
    .forEach { provider ->
        Button(onClick = {
            scope.launch {
                oidc.signIn(provider) // opens the browser
                state = blocks.authApi.getAuthState()
            }
        }) { Text("Sign in with ${provider.providerName}") }
    }

// Everything else comes from state: whether the user is signed in, and the actions to render
// (password sign-in, sign-up, MFA steps). A plain action is submitted with its fields as input:
state = blocks.authApi.setAuthState(AuthApi.SetAuthState.Input.SignIn(username, password))
```

- **Federated sign-in:** don't render the state machine's `signIn:<id>` actions as buttons. The
  buttons come from the OIDC client, as above.
- **Plain actions** (no `url`) go through `setAuthState`, with the action's `fields` as input. The
  response is the next state.
- **`signOut` with a `url`** belongs to a federated session. Run `oidc.signOut()`, then call
  `getAuthState()`. It returns the identity provider's logout URL, or `null`; the SDK does not open
  it, so open it yourself if the provider's own session should end too. Never submit this action
  through `setAuthState`: that signs out without the logout URL, so the provider's session stays
  and can sign the user straight back in.
- **`unavailable`** on an action means the backend offers it but can't run it now. Show the action
  disabled, with that text as the reason.
- **`capability: webauthn-*`** actions need a passkey ceremony the Kotlin SDK does not run. Hide
  them.
- **New actions are additive.** A backend can add actions to `setAuthState` over time, so treat an
  action name you don't recognize as one to skip, not as an error.

`oidc.restore()` returns the same user as `getAuthState()` and settles `oidc.authState`. Only a
block with federated providers serves it; any other answers 404.

On Android and iOS, `relayTo` must be a custom scheme (`com.yourcompany.yourapp://auth/callback`).
An `https` URL (an Android App Link or an iOS universal link) is not supported. Any installed app
can register the same scheme and receive the sign-in callback; PKCE keeps that app from exchanging
the authorization code, because the code verifier never leaves your app.

Every API reached through `blocks` shares one cookie jar, so methods the backend gates with
`requireAuth` work after either path signs in. See [OIDC](docs/oidc.md) for the relay scheme,
JVM landing pages and typed providers.

## Generated types

### Open records

A schema with both `properties` and `additionalProperties` (TypeScript `T & Record<string, V>`) generates a class.

- The known properties are typed. `attributes: Map<String, V>` holds every other key.
- Those keys are flat on the wire, next to the properties, in both directions.
- Example: the `signUp` action of an `Auth` block's `createApi()` takes custom attributes this way. With `export const authApi = auth.createApi()`, `AuthApi.SetAuthState.Input.SignUp(username, password, attributes = mapOf("email" to email))` sends `{"action":"signUp","username":…,"password":…,"email":…}`.
- An `attributes` entry named like a property, or like the union's discriminator, isn't sent: the property wins.
- If the schema has a property named `attributes` itself, that property keeps the name and the map is `attributes_2`.

### Unions

A union (`anyOf` / `oneOf`) generates a sealed class with one subclass per arm, read and written in the spec's wire format. When every arm is an object with a string discriminator property, the subclasses are written with that property (`{"type":"email",…}`). Otherwise each value is its arm's bare JSON value:

| Arm | Kotlin | Wire |
|---|---|---|
| string, number, boolean, array, map, date-time or transferable | a subclass holding it as `value` (`Search.Query.Variant1("abc")`) | the value (`"abc"`) |
| `const` | a `data object` | its literal |
| object | a subclass with the object's properties | the object, with no extra key |

- A value decodes to the first arm, in spec order, whose JSON shape it has (its JSON type, its required keys, or its exact literal).
- A value that matches no arm throws a `SerializationException` naming the union.
- A boolean or numeric discriminator is written and matched with that JSON type (`"isUpdated": true`).
- An arm with its own properties plus a nested `oneOf` (the `confirmSignIn` action of an `Auth` block's `createApi()`) is one flat object: `ConfirmSignIn(session, challenge = Challenge.Code(code))` sends `{"action":"confirmSignIn","session":…,"challenge":"code","code":…}`.

### Names

Generated names follow the spec, and the wire keeps the spec's names.

| Spec name | Kotlin name | Example |
|---|---|---|
| A property, parameter or operation | the spec name, in backticks where Kotlin needs them | `` `class` ``, `` `content-type` `` |
| A name Kotlin can't declare even in backticks: one holding `.`, `;`, `[`, `]`, `/`, `<`, `>`, `:`, `\`, a backtick or a control character such as a line break | its words in camelCase | the key `back\slash` is the property `backSlash` with `@SerialName("back\\slash")`; the method `a.b.ping` is `A.bPing()`, which still calls `a.b.ping` |
| A type, enum constant or union subclass | PascalCase | `InProgress` |

- When two names land on one Kotlin name in the same scope (properties `user_name` and `userName` with inline object types, discriminator values `in-progress` and `in_progress`), the first keeps it and the next gets `_2`, then `_3`, and so on.
- A nested type named like a property of its class is numbered the same way (`Meta: Meta_2`).
- Enum constants that meet are numbered without the underscore (`InProgress`, `InProgress2`).
- An operation's parameter named `client`, `request`, `args`, `result` or `json` keeps that name; the generated code around it adapts.

## Errors

Every exception in this table extends `BlocksException`.

| Exception | Thrown when |
|---|---|
| `ApiException` | The server answers with a JSON-RPC error, even on HTTP 200. `status` comes from the positive RPC error code, or is 500 for a reserved code. Match the error's `name` with `e.isBlocksError("<name>")`. |
| `TransportException` | The request produced no usable JSON-RPC result: the connection failed, the response was not a JSON-RPC envelope (for example a gateway's own error), or a method with a non-null return type got no `result`. `statusCode` is `null` when no response arrived. |
| `ClientClosedException` | The request goes through a `Blocks` instance that is closed. |
| `OidcUnknownProviderException` | `signIn` or `exchange` gets a provider the backend has not configured. `provider` is its name. |
| `OidcCallbackException` | In `signIn`: the authorize-params request fails, the identity provider reports an error, or the redirect lacks `state` or `code` or carries a state or CSRF value that does not match. On iOS, also when the system can't start the sign-in session or the session fails. |
| `OidcExchangeException` | The backend rejects the authorization code, or the exchange request fails or its response can't be read. |
| `OidcCancelledException` | The user leaves the sign-in without finishing (closes the Custom Tab on Android, cancels the sheet on iOS), or on the JVM no redirect arrives before the timeout. |
| `FileTransferException` | An upload or download through a file handle fails. `statusCode` is the HTTP status the presigned URL answered with, or `null` when the request got no response. |

- The four `Oidc…` exceptions extend the sealed `OidcException`.
- When a request failed, the `cause` of an `OidcCallbackException` or `OidcExchangeException` is an `ApiException` if the backend said why, otherwise a `TransportException`.
- [Transferables](docs/transferables.md) covers `TransferableException`, `RealtimeSubscriptionEndedException` and `RealtimeConnectionException`. `RealtimeChannelClosedException` is thrown by `subscribe()` on a channel that is already closed.

## Documentation

| Guide | Covers |
|---|---|
| [Gradle plugin](docs/gradle-plugin.md) | the full `cdkBlocks { }` block, tasks, and multi-module setups |
| [Runtime configuration](docs/runtime-configuration.md) | `BlocksConfig`, per-target configuration, where the session is stored, signing out |
| [OIDC](docs/oidc.md) | sign-in, relay scheme registration, JVM landing pages, typed providers |
| [Transferables](docs/transferables.md) | results that are live objects rather than data |

## Example apps

See [`example/android`](example/android) for a complete Android app, or [`example/kmp`](example/kmp)
for a Kotlin Multiplatform (Compose) app that uses the plugin with a todo + auth API across Android,
iOS and desktop.

## Supported Platforms

| Platform | Engine | Cookie Storage                                                                                                          |
|----------|--------|-------------------------------------------------------------------------------------------------------------------------|
| Android | OkHttp | Android Keystore AES-256-GCM key over SharedPreferences, in the app's sandbox                                            |
| iOS | Darwin (URLSession) | Keychain Services, scoped to the app                                                                                    |
| JVM | OkHttp | AES-256-GCM encrypted files under [`~/.blocks/<applicationId>`](docs/runtime-configuration.md#what-desktop-storage-protects), with the key held by the OS — in memory if no id is set |

RPC, realtime, file bucket and OIDC work on all three targets.

## Requirements

- Kotlin 2.1+
- JDK 17+
- Gradle 7.4+
- Android Gradle Plugin 7.1+ (for Android targets)

## License

This project is licensed under the Apache License 2.0. See [LICENSE](../../LICENSE) for details.
