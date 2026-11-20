// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.plugin

import org.gradle.api.Action
import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.MapProperty
import org.gradle.api.provider.Property
import org.gradle.api.provider.SetProperty

/**
 * Configuration extension for the CDK Blocks codegen plugin.
 *
 * Applied via the `cdkBlocks` block in a module's `build.gradle.kts`.
 */
abstract class CdkBlocksExtension(project: Project) {

    /** Path to the CDK Blocks spec file. Defaults to `rootProject.file("blocks.spec.json")`. */
    abstract val apiSpec: RegularFileProperty

    /** Package name for generated code. Defaults to `"com.aws.blocks.generated"`. */
    abstract val packageName: Property<String>

    /**
     * Visibility of generated types. Set to [GeneratedVisibility.Internal] to prevent
     * generated interfaces and data classes from leaking into your module's public API.
     *
     * Defaults to [GeneratedVisibility.Public].
     */
    abstract val visibility: Property<GeneratedVisibility>

    /**
     * Server overrides. Entries here override servers with the same name from the
     * spec file, or are added as new servers if the name doesn't exist in the spec.
     *
     * Map of server name → URL.
     * A URL set here is checked the same way as one given through [servers].
     */
    abstract val serverOverrides: MapProperty<String, String>

    /**
     * Logical identities from `x-blocks-native-packages` whose transferable results stay
     * `UnknownTransferable`. An identity the spec does not declare opts nothing out and is
     * reported as `AWSBLOCKS-NATIVE-006`.
     */
    abstract val excludeNativePackages: SetProperty<String>

    internal val oidcDsl = OidcDsl()

    /** The OIDC relay target, resolved from the `oidc { }` DSL block. */
    internal val relayTo: String? get() = oidcDsl.resolve()

    init {
        apiSpec.convention(project.rootProject.layout.projectDirectory.file("blocks.spec.json"))
        packageName.convention("com.aws.blocks.generated")
        visibility.convention(GeneratedVisibility.Public)
        serverOverrides.convention(emptyMap())
        excludeNativePackages.convention(emptySet())
    }

    /**
     * Configure OIDC settings.
     *
     * ```kotlin
     * cdkBlocks {
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
     * cdkBlocks {
     *     servers {
     *         local("http://10.0.2.2:3001/cdk-blocks/api")
     *         sandbox("https://sandbox.example.com/cdk-blocks/api")
     *         prod("https://api.example.com/cdk-blocks/api")
     *         custom("staging", "https://staging.example.com/cdk-blocks/api")
     *     }
     * }
     * ```
     *
     * Servers defined here override matching entries from the spec file by name,
     * or are added as new entries if no match exists.
     *
     * Each URL is the RPC URL the generated client posts to, so it carries the
     * `/cdk-blocks/api` path. Code generation rejects a URL that does not parse,
     * has no `http://` or `https://` scheme or no host, carries a query or
     * fragment, or has no RPC path (nothing but slashes and dot segments),
     * because such a server reaches no RPC.
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

    /** Returns the configured relay target, or null when none is set. */
    internal fun resolve(): String? = relayTo?.also { validate(it) }

    private fun validate(value: String) {
        if (value.any { it.isWhitespace() }) {
            throw GradleException("cdkBlocks.oidc.relayTo contains whitespace: \"$value\"")
        }
        val scheme = value.substringBefore("://")
        if (scheme.isEmpty() || scheme == value) {
            throw GradleException(
                "cdkBlocks.oidc.relayTo is missing a scheme: \"$value\". Expected something " +
                    "like \"com.yourcompany.yourapp://auth/callback\".",
            )
        }
        if (scheme.equals("http", ignoreCase = true) || scheme.equals("https", ignoreCase = true)) {
            throw GradleException(
                "cdkBlocks.oidc.relayTo uses the $scheme scheme: \"$value\". Android and iOS " +
                    "sign-in needs a custom scheme the app registers with the operating system.",
            )
        }
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
