// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.plugin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.generator.RelayToRequirement
import com.aws.blocks.kotlin.parser.OpenRpcParser
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import com.aws.blocks.kotlin.model.Server
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.MapProperty
import org.gradle.api.provider.Property
import org.gradle.api.provider.SetProperty
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import java.net.URI
import java.net.URISyntaxException

/**
 * Gradle task that parses an `blocks.spec.json` file and generates Kotlin source files.
 */
@CacheableTask
abstract class CdkBlocksCodegenTask : DefaultTask() {

    /** The OpenRPC JSON file to parse. */
    @get:InputFile
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val openRpcFile: RegularFileProperty

    /** Package name for the generated Kotlin files. */
    @get:Input
    abstract val packageName: Property<String>

    /**
     * Server overrides from the extension DSL. Entries override spec servers
     * with the same name, or are appended as new servers.
     */
    @get:Input
    abstract val serverOverrides: MapProperty<String, String>

    /**
     * Visibility modifier for generated types.
     */
    @get:Input
    abstract val visibility: Property<GeneratedVisibility>

    /** Declared native package identities to leave unbound. */
    @get:Input
    abstract val excludeNativePackages: SetProperty<String>

    /** URI the backend relays back to once OIDC sign-in completes. */
    @get:Input
    @get:org.gradle.api.tasks.Optional
    abstract val relayTo: Property<String>

    /** How strongly this project's targets need a relay target. */
    @get:Input
    abstract val relayToRequirement: Property<RelayToRequirement>

    /** Directory where generated `.kt` files are written. */
    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @TaskAction
    fun generate() {
        val file = openRpcFile.get().asFile
        if (!file.exists()) {
            throw GradleException("AWS CDK Blocks Spec file not found: ${file.absolutePath}")
        }

        val model = OpenRpcParser.parse(file.readText())

        val overrides = serverOverrides.getOrElse(emptyMap())
        val specUrls = model.servers.associate { it.name to it.url }
        overrides.forEach { (name, url) -> validateServerUrl(name, url, specUrls[name]) }

        // Merge server overrides from the extension DSL into the parsed model.
        // Overrides replace servers with the same name; new names are appended.
        val mergedModel = if (overrides.isNotEmpty()) {
            val specServerNames = model.servers.map { it.name }.toSet()
            val updatedServers = model.servers.map { server ->
                val overrideUrl = overrides[server.name]
                if (overrideUrl != null) server.copy(url = overrideUrl) else server
            }
            val newServers = overrides
                .filter { (name, _) -> name !in specServerNames }
                .map { (name, url) -> Server(name = name, url = url) }
            model.copy(servers = updatedServers + newServers)
        } else {
            model
        }

        val generator = KotlinCodeGenerator(
            packageName = packageName.get(),
            internalVisibility = visibility.get() == GeneratedVisibility.Internal,
            relayTo = relayTo.orNull,
            relayToRequirement = relayToRequirement.get(),
            excludedPackages = excludeNativePackages.get(),
        )
        val codegenModel = CodegenModelBuilder().build(mergedModel)
        val result = generator.generate(codegenModel)

        // Generate before clearing, so a rejected spec leaves the previous sources in place.
        // The clear and the write are not atomic: that guarantee covers a spec rejected
        // before writing starts, not a crash part-way through it.
        val outputDir = outputDirectory.get().asFile
        if (outputDir.exists()) {
            outputDir.deleteRecursively()
        }
        outputDir.mkdirs()

        result.warnings.forEach { logger.warn("w: $it") }
        result.files.forEach { it.writeTo(outputDir) }

        logger.lifecycle("Generated ${result.files.size} file(s) in ${outputDir.absolutePath}")
    }

    /**
     * The generated `Servers` constant is a server URL as given, and the client posts
     * to it with `/<namespace>` appended. An override the client could not post RPC to
     * is rejected here, where the spec is known; the rules a user sees are listed on
     * [CdkBlocksExtension.servers]. The host is read from the raw authority because
     * `URI.host` is null for a host the RFC rejects but resolvers accept, such as one
     * with an underscore. [specUrl] is the spec's URL for the same server name, the one
     * to point the user at: a stage prefix such as `/prod` cannot be derived from the
     * origin alone.
     */
    private fun validateServerUrl(name: String, url: String, specUrl: String?) {
        val fix = if (specUrl != null) {
            "the spec declares \"$name\" as \"$specUrl\""
        } else {
            "the one for that deployment; the dev server writes it to .cdk-blocks-sandbox/config.json, " +
                "a sandbox or production deploy to .cdk-blocks-sandbox/config.<stage>.json"
        }
        val uri = try {
            URI(url)
        } catch (cause: URISyntaxException) {
            throw GradleException(
                "cdkBlocks.servers: \"$name\" is \"$url\", which is not a valid URL (${cause.reason}). " +
                    "Use the full RPC URL ($fix).",
                cause,
            )
        }
        if (!uri.scheme.equals("http", ignoreCase = true) && !uri.scheme.equals("https", ignoreCase = true)) {
            throw GradleException(
                "cdkBlocks.servers: \"$name\" is \"$url\", which has no http:// or https:// scheme. " +
                    "Use the full RPC URL ($fix).",
            )
        }
        val authority = uri.rawAuthority
        if (authority == null || authority.substringAfterLast('@').substringBefore(':').isEmpty()) {
            throw GradleException(
                "cdkBlocks.servers: \"$name\" is \"$url\", which has no host. Use the full RPC URL ($fix).",
            )
        }
        if (uri.rawQuery != null || uri.rawFragment != null) {
            throw GradleException(
                "cdkBlocks.servers: \"$name\" is \"$url\", which carries a query or fragment. " +
                    "A server URL is the RPC base the client posts to, so give the URL without them ($fix).",
            )
        }
        // `path` decodes `%2F` and `%2E` to `/` and `.`, so an encoded-only path is rejected
        // like a bare one; tests pin `/%2F` and `/%2E`, so the filter must not be relaxed.
        val segments = uri.normalize().path.split('/').filter { it.isNotEmpty() && it != "." && it != ".." }
        if (segments.isNotEmpty()) return
        throw GradleException(
            "cdkBlocks.servers: \"$name\" is \"$url\", which has no RPC path. An AWS CDK Blocks backend serves RPC " +
                "under /cdk-blocks/api, not at the origin, so every call through this server fails. " +
                "Use the full RPC URL, for example \"${uri.scheme}://${uri.rawAuthority}/cdk-blocks/api\" ($fix).",
        )
    }
}
