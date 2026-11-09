package com.aws.blocks.plugin

import com.aws.blocks.kotlin.generator.RelayToRequirement
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldEndWith
import org.gradle.api.Project
import org.gradle.testfixtures.ProjectBuilder

private fun project(vararg plugins: String): Project = ProjectBuilder.builder().build().also { p ->
    plugins.forEach { p.plugins.apply(it) }
    p.plugins.apply("com.aws.blocks.kotlin")
}

private fun jvmProject(): Project = project("java-library", "org.jetbrains.kotlin.jvm")

private fun kmpProject(): Project = project("org.jetbrains.kotlin.multiplatform")

class AwsBlocksExtensionWiringTest : FunSpec({

    // Android needs AGP, unreachable under ProjectBuilder; KMP's relayToRequirement is
    // a placeholder afterEvaluate replaces. Neither is asserted.
    test("every extension input reaches the JVM codegen task") {
        val project = jvmProject()
        project.extensions.getByType(AwsBlocksExtension::class.java).apply {
            apiSpec.set(project.layout.projectDirectory.file("probe.spec.json"))
            packageName.set("com.probe.gen")
            serverOverrides.set(mapOf("local" to "http://127.0.0.1:1"))
            excludeNativePackages.set(setOf("example-iot-native"))
            visibility.set(GeneratedVisibility.Internal)
            oidc { it.relayTo = "com.probe.app://auth/callback" }
        }

        val task = project.tasks.getByName("awsBlocksCodegen") as AwsBlocksCodegenTask
        task.openRpcFile.get().asFile.name shouldBe "probe.spec.json"
        task.packageName.get() shouldBe "com.probe.gen"
        task.serverOverrides.get() shouldBe mapOf("local" to "http://127.0.0.1:1")
        task.excludeNativePackages.get() shouldBe setOf("example-iot-native")
        task.visibility.get() shouldBe GeneratedVisibility.Internal
        task.relayTo.get() shouldBe "com.probe.app://auth/callback"
        task.relayToRequirement.get() shouldBe RelayToRequirement.NotNeeded
        task.outputDirectory.get().asFile.path shouldEndWith "generated/source/aws/blocks/main"
    }

    test("excludeNativePackages set on the extension reaches the KMP codegen task") {
        val project = kmpProject()
        project.extensions.getByType(AwsBlocksExtension::class.java)
            .excludeNativePackages.set(setOf("example-iot-native"))

        val task = project.tasks.getByName("awsBlocksCodegen") as AwsBlocksCodegenTask
        task.excludeNativePackages.get() shouldBe setOf("example-iot-native")
        task.outputDirectory.get().asFile.path shouldEndWith "generated/source/aws/blocks/commonMain"
    }
})
