package com.aws.blocks.plugin

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.string.shouldContain
import org.gradle.testkit.runner.GradleRunner
import java.io.File

private val UNDEFINED_KIND_SPEC = """
{
  "openrpc": "1.3.2",
  "info": { "title": "test", "version": "1.0.0" },
  "methods": [ { "name": "api.connectDevice", "params": [], "result": { "name": "R",
    "schema": { "x-blocks-transferable": "example-iot/device-link" } } } ],
  "x-blocks-native-packages": { "schemaVersion": 1, "packages": { "example-iot-native": { "platforms": {
    "android": { "package": { "group": "g", "artifact": "a", "kotlinPackage": "com.example.blocks.iot" } } } } } },
  "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": [ { "id": "typo", "kind": "transferrable",
    "tag": "example-iot/device-link", "package": "example-iot-native", "export": "deviceLink",
    "abi": "blocks-transferable-v1", "genericArity": 0 } ] }
}
""".trimIndent()

class CodegenWarningLogTest : FunSpec({

    test("a real build forwards AWSBLOCKS-NATIVE-004 to the build log") {
        val root = File(System.getProperty("java.io.tmpdir"), "blocks-warnlog-" + System.nanoTime())
        root.mkdirs()
        File(root, "settings.gradle.kts").writeText("rootProject.name = \"probe\"\n")
        File(root, "blocks.spec.json").writeText(UNDEFINED_KIND_SPEC)
        File(root, "build.gradle.kts").writeText(
            """
            plugins {
                id("org.jetbrains.kotlin.jvm")
                id("org.jetbrains.kotlin.plugin.serialization")
                id("com.aws.blocks.kotlin")
            }
            awsBlocks {
                apiSpec.set(file("blocks.spec.json"))
                packageName.set("com.example.app")
            }
            """.trimIndent(),
        )

        val result = GradleRunner.create()
            .withProjectDir(root)
            .withPluginClasspath(injectedClasspath())
            .withArguments("awsBlocksCodegen", "--offline")
            .build()

        // The `w: ` prefix is the task's own forwarding, so this pins the log hop too.
        result.output shouldContain "w: AWSBLOCKS-NATIVE-004: binding 'typo' declares kind 'transferrable'"
    }
})

private fun injectedClasspath(): List<File> =
    System.getProperty("java.class.path").split(File.pathSeparator).map(::File)
