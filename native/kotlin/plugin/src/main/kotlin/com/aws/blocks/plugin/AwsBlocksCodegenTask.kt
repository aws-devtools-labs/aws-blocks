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
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

/**
 * Gradle task that parses an `blocks.spec.json` file and generates Kotlin source files.
 */
@CacheableTask
abstract class AwsBlocksCodegenTask : DefaultTask() {

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
            throw GradleException("Blocks Spec file not found: ${file.absolutePath}")
        }

        val outputDir = outputDirectory.get().asFile

        // Clear previous output
        if (outputDir.exists()) {
            outputDir.deleteRecursively()
        }
        outputDir.mkdirs()

        val json = file.readText()
        val model = OpenRpcParser.parse(json)

        // Merge server overrides from the extension DSL into the parsed model.
        // Overrides replace servers with the same name; new names are appended.
        val overrides = serverOverrides.getOrElse(emptyMap())
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
        )
        val codegenModel = CodegenModelBuilder().build(mergedModel)
        val result = generator.generate(codegenModel)
        result.warnings.forEach { logger.warn("w: $it") }
        result.files.forEach { it.writeTo(outputDir) }

        logger.lifecycle("Generated ${result.files.size} file(s) in ${outputDir.absolutePath}")
    }
}
