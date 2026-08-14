package com.aws.blocks.plugin

import com.aws.blocks.kotlin.model.ModelPrettyPrinter
import com.aws.blocks.kotlin.parser.OpenRpcParser
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.work.DisableCachingByDefault

/**
 * Gradle task that parses the configured OpenRPC spec file and prints
 * a human-readable representation of the resulting [com.aws.blocks.kotlin.model.RpcModel] to stdout.
 *
 * This is a debugging aid: when generated code is wrong, a developer can
 * inspect the dump to determine whether the issue is in parsing or code generation.
 *
 * Not cacheable because output goes to stdout, not a file.
 */
@DisableCachingByDefault(because = "Output goes to stdout, not a file — nothing to cache")
abstract class AwsBlocksDumpModelTask : DefaultTask() {

    /** The OpenRPC JSON spec file to parse and dump. */
    @get:InputFile
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val apiSpecFile: RegularFileProperty

    @TaskAction
    fun dump() {
        val file = apiSpecFile.get().asFile
        if (!file.exists()) {
            throw GradleException("Spec file not found: ${file.absolutePath}")
        }
        val json = file.readText()
        val model = OpenRpcParser.parse(json)
        val output = ModelPrettyPrinter.format(model)
        println(output)
    }
}
