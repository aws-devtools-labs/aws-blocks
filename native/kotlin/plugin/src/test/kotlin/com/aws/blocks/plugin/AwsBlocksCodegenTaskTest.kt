package com.aws.blocks.plugin

import com.aws.blocks.kotlin.generator.RelayToRequirement
import com.aws.blocks.kotlin.parser.OpenRpcParseException
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.gradle.testfixtures.ProjectBuilder
import java.io.File

private const val UNSUPPORTED_SCHEMA_VERSION = """
{
  "openrpc": "1.3.2",
  "info": { "title": "test", "version": "1.0.0" },
  "methods": [],
  "x-blocks-native-packages": { "schemaVersion": 2, "packages": {} }
}
"""

private const val ARITY_MISMATCH = """
{
  "openrpc": "1.3.2",
  "info": { "title": "test", "version": "1.0.0" },
  "methods": [ { "name": "api.connectDevice", "params": [], "result": { "name": "R",
    "schema": { "oneOf": [ { "x-blocks-transferable": "example-iot/device-link" }, { "type": "null" } ] } } } ],
  "x-blocks-native-packages": { "schemaVersion": 1, "packages": { "p": { "platforms": {
    "android": { "package": { "group": "g", "artifact": "a", "kotlinPackage": "com.example.blocks.iot" } } } } } },
  "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": [ { "id": "b", "kind": "transferable",
    "tag": "example-iot/device-link", "package": "p", "export": "deviceLink",
    "abi": "blocks-transferable-v1", "genericArity": 1 } ] }
}
"""

private const val BOUND_SPEC = """
{
  "openrpc": "1.3.2",
  "info": { "title": "test", "version": "1.0.0" },
  "methods": [ { "name": "api.connectDevice", "params": [], "result": { "name": "R",
    "schema": { "x-blocks-transferable": "example-iot/device-link" } } } ],
  "x-blocks-native-packages": { "schemaVersion": 1, "packages": { "example-iot-native": { "platforms": {
    "android": { "package": { "group": "g", "artifact": "a", "kotlinPackage": "com.example.blocks.iot" } } } } } },
  "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": [ { "id": "b", "kind": "transferable",
    "tag": "example-iot/device-link", "package": "example-iot-native", "export": "deviceLink",
    "abi": "blocks-transferable-v1", "genericArity": 0 } ] }
}
"""

private const val EMPTY_SPEC = """
{
  "openrpc": "1.3.2",
  "info": { "title": "test", "version": "1.0.0" },
  "methods": []
}
"""

private class StaleOutput(spec: String, excluded: Set<String> = emptySet()) {
    private val project = ProjectBuilder.builder().build()
    val outputDir: File = File(project.projectDir, "generated").apply { mkdirs() }
    val previous: File = File(outputDir, "Api.kt").apply { writeText("// from the previous run") }

    fun generatedApi(): String = File(outputDir, "com/example/app/Api.kt").readText()

    val task: AwsBlocksCodegenTask = project.tasks
        .register("probe", AwsBlocksCodegenTask::class.java).get().apply {
            openRpcFile.set(File(project.projectDir, "blocks.spec.json").apply { writeText(spec) })
            packageName.set("com.example.app")
            serverOverrides.set(emptyMap<String, String>())
            excludeNativePackages.set(excluded)
            visibility.set(GeneratedVisibility.Public)
            relayToRequirement.set(RelayToRequirement.NotNeeded)
            outputDirectory.set(outputDir)
        }
}

class AwsBlocksCodegenTaskTest : FunSpec({

    test("a rejected spec leaves previously generated sources in place") {
        val run = StaleOutput(UNSUPPORTED_SCHEMA_VERSION)

        shouldThrow<OpenRpcParseException> { run.task.generate() }

        run.previous.readText() shouldBe "// from the previous run"
    }

    test("a spec rejected during code generation leaves previously generated sources in place") {
        val run = StaleOutput(ARITY_MISMATCH)

        shouldThrow<OpenRpcParseException> { run.task.generate() }

        run.previous.readText() shouldBe "// from the previous run"
    }

    test("an accepted spec replaces previously generated sources") {
        val run = StaleOutput(EMPTY_SPEC)

        run.task.generate()

        run.previous.exists() shouldBe false
    }

    test("an accepted spec writes the generated client into the output directory") {
        val run = StaleOutput(BOUND_SPEC)

        run.task.generate()

        run.generatedApi() shouldContain "import com.example.blocks.iot.DeviceLink"
        run.generatedApi() shouldContain "): DeviceLink {"
    }

    test("an excluded package identity reaches the generator and keeps the fallback") {
        val run = StaleOutput(BOUND_SPEC, excluded = setOf("example-iot-native"))

        run.task.generate()

        run.generatedApi() shouldContain "): UnknownTransferable {"
        run.generatedApi() shouldNotContain "fromBlocksDescriptor"
    }
})
