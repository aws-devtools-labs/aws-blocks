# Signing in with OIDC

```kotlin
val blocks = Blocks()
val client = blocks.authApi.getClient()
val user = client.signIn(AuthApi.GetClient.Provider.Google)
```

`signIn` suspends until the flow finishes. Bringing your window to the front afterwards is the
app's job; `signIn` returning is the signal.

## Registering the relay scheme

Android and iOS hand the callback back through a URL scheme the operating system has to know about,
so the scheme is build-time configuration:

```kotlin
awsBlocks {
    oidc {
        relayTo = "com.yourcompany.yourapp://auth/callback"
    }
}
```

It must match an entry in the backend's `allowedRelayOrigins`. Setting it also decides whether the
OIDC methods are generated at all — without it they are stubbed, and calling one reports that OIDC
is not configured.

On **Android** nothing further is needed; the plugin injects the scheme into the merged manifest.

On **iOS**, declare the same scheme in the app's `Info.plist` under `CFBundleURLTypes` — the Gradle
plugin cannot reach an Xcode project.

On the **JVM** it is ignored. Each sign-in binds a loopback address instead, so there is no scheme
to register and nothing to configure.

## Landing pages on the JVM

On the JVM target the system browser is left open on that loopback address once sign-in finishes,
so the runtime serves a page there. By default that is a built-in styled page. An app can replace
it per outcome, from a JVM source set:

```kotlin
client.signIn(
    provider = AuthApi.GetClient.Provider.Google,
    options = OidcSignInOptions(
        OidcSignInPlatformOptions(
            // Send the browser to your own page, so the user ends on a real domain.
            successPage = OidcLandingPage.Redirect("https://app.example.com/signed-in"),
            // Or serve your own markup, with nothing to host.
            errorPage = OidcLandingPage.Html(myLocalizedFailurePage),
        ),
    ),
)
```

`OidcSignInPlatformOptions` has a different shape on each target, so it is only constructible where
it applies — from `jvmMain` or `desktopMain`, not from `commonMain`. Shared code that calls
`signIn(provider)` with no options needs no platform code and gets the built-in pages. Android and
iOS have no options to set: their in-app browser dismisses itself.

| `OidcLandingPage` | Effect |
|---|---|
| `BuiltIn` (default) | The runtime's own page. The failure variant shows the provider's error, HTML-escaped. |
| `Redirect(url)` | A 302 to `url`. Requires `https`, except on a loopback host for local development. |
| `Html(document)` | `document` served verbatim. Must be a complete HTML document. |

A `Redirect` is sent a clean URL: the callback query is dropped on success, so the authorization
code and `state` are not appended to it, and on failure only `error` and `error_description` are.
An `Html` page receives nothing, so use `Redirect` if you need the provider's reason.

`error` is the provider's own code when the provider reported the failure. When it did not, it
names the step that failed instead, so a page can tell the cases apart:

| `error` | Meaning |
|---|---|
| `invalid_callback` | The callback arrived but was rejected — a missing or mismatched `state`, or a bad CSRF value. |
| `exchange_failed` | The code could not be exchanged, including a backend that could not be reached. |
| `cancelled` | The caller stopped waiting, such as a screen that was closed mid-flow. |

`error_description` is only set for failures the runtime itself describes; a message from a
transport or parser is omitted rather than shown to the user.

### What a landing page can see

`BuiltIn` and `Html` are served as the response to the callback itself, so the callback query stays
in the address bar and in `document.location` while that page is open. Markup you supply through
`Html` can therefore read the authorization code; prefer `Redirect` if the page runs anything you
would not want to see it, such as third-party analytics.

## Typed providers

`OidcClient` is generic over the providers it signs in with, which are `OidcProvider`s. When the
spec names an OIDC client's providers, the method's object gets a `Provider` enum that implements
`OidcProvider`, whose constants carry the names the backend knows them by, and `getClient()`
returns a client typed by it:

```kotlin
val client = blocks.authApi.getClient()        // OidcClient<AuthApi.GetClient.Provider>
val user = client.signIn(AuthApi.GetClient.Provider.Google)

// A sign-in screen. `entries` is what the spec named when it was generated; `client.providers` is
// what the deployed backend reports now, so the screen shows the providers both agree on.
AuthApi.GetClient.Provider.entries
    .filter { it.providerName in client.providers }
    .forEach { provider ->
        Button(onClick = { scope.launch { client.signIn(provider) } }) {
            Text("Sign in with ${provider.providerName}")
        }
    }
```

A provider name that is not a legal identifier is still spelled as one, and keeps the name it signs
in with: `login.gov` becomes `LoginGov("login.gov")`. Because the constant's name is rebuilt from
the value, `valueOf` can't find one by the name the backend uses — the generated `fromProviderName`
does:

```kotlin
// Restoring a provider read from a saved session, or off a deep-link callback
val provider = AuthApi.GetClient.Provider.fromProviderName(saved) ?: return
client.signIn(provider)
```

When the spec does not name them — the providers resolved to plain strings — `getClient()` returns
`OidcClient<AnyProvider>`, whose `signIn` and `exchange` take a provider name, as before:

```kotlin
// Signing in by name is an extension on this one instantiation, so it needs importing.
import com.aws.blocks.kotlin.oidc.signIn

val client = blocks.authApi.getClient()        // OidcClient<AnyProvider>
val user = client.signIn("google")
```

Without that import the call resolves to the member that takes a provider, and the compiler reports
an `AnyProvider` was expected rather than a missing import.

When the method's object already uses the name `Provider`, the enum is `ResultProvider` and codegen
prints a `kotlin:` warning that names it.

## Signing out

`client.signOut()` revokes the session server-side and expires the session cookie as part of its
response, which is what clears it locally. See
[runtime configuration](runtime-configuration.md#signing-out).
