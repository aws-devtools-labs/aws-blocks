# Gradle plugin reference

The `com.aws.blocks.kotlin` plugin parses your AWS CDK Blocks spec at build time and generates the
client. This is the full `cdkBlocks { }` surface; the [README](../README.md) covers the two
properties most projects set.

## The `cdkBlocks` block

Every property is optional. Override one in your app module's `build.gradle.kts` when the default
does not fit:

```kotlin
import com.aws.blocks.plugin.GeneratedVisibility

cdkBlocks {
    // Path to the generated spec file (defaults to rootProject.file("blocks.spec.json"))
    apiSpec = rootProject.file("path/to/your/blocks.spec.json")

    // Package name for generated code (defaults to "com.aws.blocks.generated")
    packageName = "com.example.myapp.generated"

    // Visibility of generated types: Public (default) or Internal
    visibility = GeneratedVisibility.Internal

    // Override or add server URLs (optional). Each is the RPC URL, not the origin.
    servers {
        local("http://10.0.2.2:3001/cdk-blocks/api")
        sandbox("https://sandbox.example.com/cdk-blocks/api")
        prod("https://api.example.com/cdk-blocks/api")
        custom("staging", "https://staging.example.com/cdk-blocks/api")
    }

    // Logical identities from x-blocks-native-packages that keep the
    // UnknownTransferable fallback instead of a declared type (optional).
    // An identity the spec does not declare only warns, as AWSBLOCKS-NATIVE-006
    excludeNativePackages = setOf("example-iot-native")

    // Only needed to use the OIDC client on Android or iOS. See docs/oidc.md.
    oidc {
        relayTo = "com.yourcompany.yourapp://auth/callback"
    }
}
```

### `servers`

Servers defined here override entries from the spec file that share the same name. New names are
added alongside the spec's servers. Each becomes a constant on the generated `Servers` object, so
`prod("https://api.example.com/cdk-blocks/api")` is reachable as `Servers.prod`.

A server URL is the RPC URL itself: the `apiUrl` that `npm run dev` writes to
`.cdk-blocks-sandbox/config.json`, or a deploy to `.cdk-blocks-sandbox/config.<stage>.json`, whose path ends
in `/cdk-blocks/api`. It is not the origin that serves it. The generated client posts to the URL as
given, so an override such as `local("http://10.0.2.2:3001")` replaces the
`http://localhost:3001/cdk-blocks/api` the client would otherwise use with the bare origin, and
every call through it, including `Blocks()` when that is the spec's first server, fails (`HTTP 404`
from the local dev server, `HTTP 403` from a deployed API Gateway).

Code generation rejects an override that does not parse, has no `http://` or `https://` scheme or
no host, carries a query or fragment, or has no RPC path (nothing but slashes and dot segments).

The spec carries the dev server's `local` by default (`sandbox` while `npm run sandbox` proxies
through it), or the deployed `sandbox`/`production` server when the spec is generated with
`BLOCKS_SPEC_STAGE=sandbox|production`, so `prod(…)` adds a server rather than replacing the
deployed one.

Server selection is a build-time *default*, not a constraint — the generated `Blocks()` accessor
follows the spec's first server, and any other can be passed at runtime. See
[runtime configuration](runtime-configuration.md).

### `excludeNativePackages`

Names a logical identity from the spec's `x-blocks-native-packages` that should keep the
`UnknownTransferable` fallback rather than resolving to its declared Kotlin type. See
[transferables](transferables.md).

### `oidc { relayTo }`

Required to use the OIDC client on Android or iOS, where the relay scheme is registered with the
operating system. It must match an entry in the backend's `allowedRelayOrigins`. The JVM binds a
loopback address per sign-in and ignores it. Setting it also decides whether the OIDC methods are
generated at all, which is why it is build-time rather than runtime configuration. Full setup,
including the iOS `Info.plist` entry, is in [OIDC](oidc.md#registering-the-relay-scheme).

## Tasks

| Task | Description |
|------|-------------|
| `cdkBlocksCodegen<Variant>` | Generates Kotlin sources for the given Android variant (e.g. `cdkBlocksCodegenDebug`) |
| `cdkBlocksCodegen` | Generates Kotlin sources (KMP projects: into `commonMain`, JVM projects: into `main`) |
| `cdkBlocksDumpModel` | Parses the spec and dumps the intermediate model for debugging |

Codegen runs automatically as a dependency of compilation, so a normal build does not need to
invoke these directly. `cdkBlocksDumpModel` is the one to reach for when the generated API does not
match what you expected from the spec.

## One spec per compilation scope

The generated namespace accessors, `Blocks()` and `Blocks.defaultServer` are all extensions on the
runtime's `Blocks`, so one spec is assumed per compilation scope. Two generated packages visible in
the same file make `Blocks()` and `Blocks.defaultServer` ambiguous, and an accessor imported from
one while the entry point comes from the other would send its calls to the wrong backend.

A module that generates a client for its own use should set its own `packageName` and
`visibility = GeneratedVisibility.Internal`, so that its accessors stay out of its consumers' scope
and its generated types do not share fully qualified names with another module's — two modules both
left on the default `packageName` ship the same ones.
