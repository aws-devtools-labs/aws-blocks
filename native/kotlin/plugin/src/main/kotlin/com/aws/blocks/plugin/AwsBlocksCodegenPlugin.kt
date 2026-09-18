package com.aws.blocks.plugin

import com.android.build.api.variant.AndroidComponentsExtension
import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.plugins.JavaPluginExtension
import org.jetbrains.kotlin.gradle.dsl.KotlinMultiplatformExtension

/**
 * Gradle plugin that registers an [AwsBlocksCodegenTask] to generate
 * Kotlin source files from an OpenRPC spec.
 *
 * Supports three project types:
 * - **Kotlin Multiplatform**: wires generated sources into `commonMain`
 * - **Android** (application or library): wires generated sources per variant
 * - **Kotlin/JVM**: wires generated sources into the main source set
 *
 * Usage in `build.gradle.kts`:
 * ```
 * plugins {
 *     id("com.aws.blocks.kotlin")
 * }
 *
 * awsBlocks {
 *     apiSpec = file("path/to/blocks.spec.json")
 *     packageName.set("com.myapp.generated")
 * }
 *
 * dependencies {
 *    implementation("com.aws.blocks.kotlin:runtime:<version>")
 * }
 * ```
 */
class AwsBlocksCodegenPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val extension = project.extensions.create(
            "awsBlocks",
            AwsBlocksExtension::class.java,
            project,
        )

        project.afterEvaluate {
            if (!project.plugins.hasPlugin("org.jetbrains.kotlin.plugin.serialization")) {
                throw GradleException(
                    "The AWS Blocks codegen plugin requires the kotlinx.serialization plugin. " +
                        "Add `id(\"org.jetbrains.kotlin.plugin.serialization\")` to your module's plugins block.",
                )
            }
        }

        project.tasks.register("awsBlocksDumpModel", AwsBlocksDumpModelTask::class.java) {
            it.apiSpecFile.set(extension.apiSpec)
        }

        project.pluginManager.withPlugin("org.jetbrains.kotlin.multiplatform") {
            configureKmp(project, extension)
        }

        project.pluginManager.withPlugin("com.android.application") {
            if (!hasKmp(project)) {
                configureAndroid(project, extension)
            }
        }

        project.pluginManager.withPlugin("com.android.library") {
            if (!hasKmp(project)) {
                configureAndroid(project, extension)
            }
        }

        project.pluginManager.withPlugin("org.jetbrains.kotlin.jvm") {
            if (!hasKmp(project) && !hasAndroid(project)) {
                configureJvm(project, extension)
            }
        }
    }

    private fun hasKmp(project: Project): Boolean =
        project.plugins.hasPlugin("org.jetbrains.kotlin.multiplatform")

    private fun hasAndroid(project: Project): Boolean =
        project.plugins.hasPlugin("com.android.application") ||
            project.plugins.hasPlugin("com.android.library")

    private fun configureKmp(project: Project, extension: AwsBlocksExtension) {
        val outputDir = project.layout.buildDirectory.dir("generated/source/aws/blocks/commonMain")

        val task = project.tasks.register("awsBlocksCodegen", AwsBlocksCodegenTask::class.java)
        task.configure {
            it.openRpcFile.set(extension.apiSpec)
            it.packageName.set(extension.packageName)
            it.serverOverrides.set(extension.serverOverrides)
            it.visibility.set(extension.visibility)
            it.relayTo.set(extension.relayTo)
            it.outputDirectory.set(outputDir)
        }

        val kmpExtension = project.extensions.getByType(KotlinMultiplatformExtension::class.java)
        kmpExtension.sourceSets.getByName("commonMain").kotlin.srcDir(task.map { it.outputDirectory })

        project.pluginManager.withPlugin("com.android.application") {
            injectOidcManifestPlaceholder(project, extension)
        }
        project.pluginManager.withPlugin("com.android.library") {
            injectOidcManifestPlaceholder(project, extension)
        }
    }

    private fun configureAndroid(project: Project, extension: AwsBlocksExtension) {
        val androidComponents = project.extensions.getByType(AndroidComponentsExtension::class.java)

        injectOidcManifestPlaceholder(project, extension)

        androidComponents.onVariants { variant ->
            val variantName = variant.name
            val taskName = "awsBlocksCodegen${variantName.replaceFirstChar { it.uppercaseChar() }}"

            val outputDir = project.layout.buildDirectory.dir(
                "generated/source/aws/blocks/$variantName",
            )

            val task = project.tasks.register(taskName, AwsBlocksCodegenTask::class.java)
            task.configure {
                it.openRpcFile.set(extension.apiSpec)
                it.packageName.set(extension.packageName)
                it.serverOverrides.set(extension.serverOverrides)
                it.visibility.set(extension.visibility)
                it.relayTo.set(extension.relayTo)
                it.outputDirectory.set(outputDir)
            }

            variant.sources.java?.addGeneratedSourceDirectory(task, AwsBlocksCodegenTask::outputDirectory)
        }
    }

    private fun configureJvm(project: Project, extension: AwsBlocksExtension) {
        val outputDir = project.layout.buildDirectory.dir("generated/source/aws/blocks/main")

        val task = project.tasks.register("awsBlocksCodegen", AwsBlocksCodegenTask::class.java)
        task.configure {
            it.openRpcFile.set(extension.apiSpec)
            it.packageName.set(extension.packageName)
            it.serverOverrides.set(extension.serverOverrides)
            it.visibility.set(extension.visibility)
            it.relayTo.set(extension.relayTo)
            it.outputDirectory.set(outputDir)
        }

        project.extensions.getByType(JavaPluginExtension::class.java)
            .sourceSets.getByName("main").java.srcDir(task.map { it.outputDirectory })
    }

    private fun injectOidcManifestPlaceholder(project: Project, extension: AwsBlocksExtension) {
        val androidComponents = project.extensions.getByType(AndroidComponentsExtension::class.java)
        androidComponents.onVariants { variant ->
            val relayTo = extension.relayTo
            val hasRedirectScheme = relayTo != null
            val scheme = relayTo?.substringBefore("://") ?: "disabled"
            variant.manifestPlaceholders.put("oidcRedirectScheme", scheme)
            variant.manifestPlaceholders.put("oidcActivityExported", if (hasRedirectScheme) "true" else "false")
        }
    }
}
