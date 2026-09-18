package com.aws.blocks.plugin

import org.gradle.api.Action
import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.MapProperty
import org.gradle.api.provider.Property

/**
 * Configuration extension for the AWS Blocks codegen plugin.
 *
 * Applied via the `awsBlocks` block in a module's `build.gradle.kts`.
 */
abstract class AwsBlocksExtension(project: Project) {

    /** Path to the Blocks spec file. Defaults to `rootProject.file("blocks.spec.json")`. */
    abstract val apiSpec: RegularFileProperty

    /** Package name for generated code. Defaults to `"com.aws.blocks.generated"`. */
    abstract val packageName: Property<String>

    /**
     * Visibility of generated types. Set to [GeneratedVisibility.INTERNAL] to prevent
     * generated interfaces and data classes from leaking into your module's public API.
     *
     * Defaults to [GeneratedVisibility.PUBLIC].
     */
    abstract val visibility: Property<GeneratedVisibility>

    /**
     * Server overrides. Entries here override servers with the same name from the
     * spec file, or are added as new servers if the name doesn't exist in the spec.
     *
     * Map of server name → URL.
     */
    abstract val serverOverrides: MapProperty<String, String>

    internal val oidcDsl = OidcDsl()

    /** The OIDC relay target, resolved from the `oidc { }` DSL block. */
    internal val relayTo: String? get() = oidcDsl.resolve()

    init {
        apiSpec.convention(project.rootProject.layout.projectDirectory.file("blocks.spec.json"))
        packageName.convention("com.aws.blocks.generated")
        visibility.convention(GeneratedVisibility.Public)
        serverOverrides.convention(emptyMap())
    }

    /**
     * Configure OIDC settings.
     *
     * ```kotlin
     * awsBlocks {
     *     oidc {
     *         relayTo = "com.yourcompany.yourapp://auth/callback"
     *     }
     * }
     * ```
     */
    fun oidc(action: Action<OidcDsl>) {
        action.execute(oidcDsl)
    }

    /**
     * Configure server URLs via a DSL block.
     *
     * ```kotlin
     * awsBlocks {
     *     servers {
     *         local("http://10.0.2.2:3001")
     *         sandbox("https://sandbox.example.com")
     *         prod("https://api.example.com")
     *         custom("staging", "https://staging.example.com")
     *     }
     * }
     * ```
     *
     * Servers defined here override matching entries from the spec file by name,
     * or are added as new entries if no match exists.
     */
    fun servers(action: Action<ServersDsl>) {
        val dsl = ServersDsl()
        action.execute(dsl)
        serverOverrides.putAll(dsl.entries)
    }
}

/**
 * DSL for configuring OIDC authentication.
 */
class OidcDsl {
    /**
     * URI the backend relays back to once sign-in completes, for example
     * `"com.yourcompany.yourapp://auth/callback"`. Must match an entry in the backend's
     * `allowedRelayOrigins`.
     *
     * Required on Android and iOS, where the scheme is registered with the operating system.
     * Unused on JVM, which receives the relay on a loopback address it binds per sign-in.
     */
    var relayTo: String? = null

    @Deprecated(
        message = "Renamed to relayTo, matching the backend's allowedRelayOrigins and the wire field.",
        replaceWith = ReplaceWith("relayTo"),
        level = DeprecationLevel.WARNING,
    )
    var redirectUrl: String? = null

    /**
     * Returns the configured relay target, accepting either property name.
     *
     * Both names write separate fields so that setting them to conflicting values is
     * detectable rather than resolved by assignment order.
     */
    internal fun resolve(): String? {
        @Suppress("DEPRECATION")
        val legacy = redirectUrl
        val current = relayTo
        if (legacy != null && current != null && legacy != current) {
            throw GradleException(
                "awsBlocks.oidc: relayTo (\"$current\") and the deprecated redirectUrl " +
                    "(\"$legacy\") are set to different values. Remove redirectUrl.",
            )
        }
        return current ?: legacy
    }
}

/**
 * DSL for declaring server URL overrides.
 *
 * Provides convenience methods for well-known environments (`local`, `sandbox`, `prod`)
 * and a generic `custom` method for anything else.
 */
class ServersDsl {
    internal val entries = mutableMapOf<String, String>()

    /** Override or add the `local` server URL. */
    fun local(url: String) {
        entries["local"] = url
    }

    /** Override or add the `sandbox` server URL. */
    fun sandbox(url: String) {
        entries["sandbox"] = url
    }

    /** Override or add the `prod` server URL. */
    fun prod(url: String) {
        entries["prod"] = url
    }

    /** Override or add a server with an arbitrary name. */
    fun custom(name: String, url: String) {
        entries[name] = url
    }
}

/**
 * Visibility modifier for generated types.
 */
enum class GeneratedVisibility {
    Public,
    Internal,
}
