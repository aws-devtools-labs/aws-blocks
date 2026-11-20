// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.plugin

import com.android.build.api.variant.AndroidComponentsExtension
import com.android.build.api.variant.TestComponent
import com.aws.blocks.kotlin.generator.RelayToRequirement
import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.file.Directory
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.api.provider.Provider
import org.jetbrains.kotlin.gradle.dsl.KotlinMultiplatformExtension
import org.jetbrains.kotlin.gradle.plugin.KotlinPlatformType
import org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget
import org.jetbrains.kotlin.konan.target.Family
import org.jetbrains.kotlin.konan.target.KonanTarget

/**
 * Gradle plugin that registers an [CdkBlocksCodegenTask] to generate
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
 *     id("org.jetbrains.kotlin.plugin.serialization") version "<kotlin version>"
 *     id("com.aws.blocks.kotlin") version "<version>"
 * }
 *
 * cdkBlocks {
 *     apiSpec = file("path/to/blocks.spec.json")
 *     packageName.set("com.myapp.generated")
 * }
 *
 * dependencies {
 *    implementation("com.aws.blocks.kotlin:runtime:<version>")
 * }
 * ```
 */
class CdkBlocksCodegenPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val extension = project.extensions.create(
            "cdkBlocks",
            CdkBlocksExtension::class.java,
            project,
        )

        project.afterEvaluate {
            if (!project.plugins.hasPlugin("org.jetbrains.kotlin.plugin.serialization")) {
                throw GradleException(
                    "The AWS CDK Blocks codegen plugin requires the kotlinx.serialization plugin. " +
                        "Add `id(\"org.jetbrains.kotlin.plugin.serialization\")` to your module's plugins block.",
                )
            }
        }

        project.tasks.register("cdkBlocksDumpModel", CdkBlocksDumpModelTask::class.java) {
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

    /**
     * Every registration path sets every input the task declares; only the relay requirement
     * differs, and the KMP path passes a placeholder that `afterEvaluate` replaces once targets
     * are known.
     */
    private fun configureCodegenTask(
        task: CdkBlocksCodegenTask,
        extension: CdkBlocksExtension,
        outputDir: Provider<Directory>,
        relayToRequirement: RelayToRequirement,
    ) {
        task.openRpcFile.set(extension.apiSpec)
        task.packageName.set(extension.packageName)
        task.serverOverrides.set(extension.serverOverrides)
        task.excludeNativePackages.set(extension.excludeNativePackages)
        task.visibility.set(extension.visibility)
        task.relayTo.set(extension.relayTo)
        task.relayToRequirement.set(relayToRequirement)
        task.outputDirectory.set(outputDir)
    }

    private fun configureKmp(project: Project, extension: CdkBlocksExtension) {
        val outputDir = project.layout.buildDirectory.dir("generated/source/cdk/blocks/commonMain")

        val task = project.tasks.register("cdkBlocksCodegen", CdkBlocksCodegenTask::class.java)
        task.configure { configureCodegenTask(it, extension, outputDir, RelayToRequirement.NotNeeded) }

        val kmpExtension = project.extensions.getByType(KotlinMultiplatformExtension::class.java)
        kmpExtension.sourceSets.getByName("commonMain").kotlin.srcDir(task.map { it.outputDirectory })

        // Targets are registered by the consumer's own `kotlin { }` block, so the decision
        // has to wait until the project is evaluated. A plain value keeps the task input
        // configuration-cache friendly.
        project.afterEvaluate {
            val requirement = relayToRequirementFor(
                kmpExtension.targets.map { target ->
                    TargetPlatform(
                        platformType = target.platformType,
                        konanTarget = (target as? KotlinNativeTarget)?.konanTarget,
                    )
                },
            )
            task.configure {
                it.relayToRequirement.set(requirement)
            }
        }

        project.pluginManager.withPlugin("com.android.application") {
            injectOidcManifestPlaceholder(project, extension)
        }
        project.pluginManager.withPlugin("com.android.library") {
            injectOidcManifestPlaceholder(project, extension)
        }
        // A multiplatform module declares its Android target through this plugin rather than
        // `com.android.library`. Its own AAR merges the runtime's manifest with the placeholders
        // left unresolved, which is fine — a library defers them to whatever consumes it. Its
        // instrumented test APK does not: that merge is an application merge, and an unresolved
        // placeholder fails it.
        project.pluginManager.withPlugin("com.android.kotlin.multiplatform.library") {
            injectOidcManifestPlaceholder(project, extension)
        }
    }

    private fun configureAndroid(project: Project, extension: CdkBlocksExtension) {
        val androidComponents = project.extensions.getByType(AndroidComponentsExtension::class.java)

        injectOidcManifestPlaceholder(project, extension)

        androidComponents.onVariants { variant ->
            val variantName = variant.name
            val taskName = "cdkBlocksCodegen${variantName.replaceFirstChar { it.uppercaseChar() }}"

            val outputDir = project.layout.buildDirectory.dir(
                "generated/source/cdk/blocks/$variantName",
            )

            val task = project.tasks.register(taskName, CdkBlocksCodegenTask::class.java)
            task.configure { configureCodegenTask(it, extension, outputDir, RelayToRequirement.Required) }

            variant.sources.java?.addGeneratedSourceDirectory(task, CdkBlocksCodegenTask::outputDirectory)
        }
    }

    private fun configureJvm(project: Project, extension: CdkBlocksExtension) {
        val outputDir = project.layout.buildDirectory.dir("generated/source/cdk/blocks/main")

        val task = project.tasks.register("cdkBlocksCodegen", CdkBlocksCodegenTask::class.java)
        task.configure { configureCodegenTask(it, extension, outputDir, RelayToRequirement.NotNeeded) }

        project.extensions.getByType(JavaPluginExtension::class.java)
            .sourceSets.getByName("main").java.srcDir(task.map { it.outputDirectory })
    }

    private fun injectOidcManifestPlaceholder(project: Project, extension: CdkBlocksExtension) {
        // On older AGP (through 8.9 at least) the multiplatform Android plugin's components
        // extension did not implement AndroidComponentsExtension — it extended AndroidComponents
        // and offered `onVariant`, not `onVariants` — so there is nothing of this type to find.
        // AGP is a compileOnly dependency and the consumer's own version is what runs, so resolve
        // the extension leniently: on those versions the module keeps the behaviour it had before
        // this plugin set any placeholder, rather than failing to configure.
        val androidComponents = project.extensions.findByType(AndroidComponentsExtension::class.java)
        if (androidComponents == null) {
            project.logger.warn(
                "AWS CDK Blocks: this module's Android plugin does not expose AndroidComponentsExtension, " +
                    "so the OIDC manifest placeholders were not set. Building an instrumented test APK " +
                    "here fails its manifest merge on `oidcRedirectScheme`/`oidcActivityExported`. " +
                    "Android Gradle Plugin 8.11 or newer exposes it.",
            )
            return
        }
        androidComponents.onVariants { variant ->
            val relayTo = extension.relayTo
            val hasRedirectScheme = relayTo != null
            val scheme = relayTo?.substringBefore("://") ?: "disabled"
            val exported = if (hasRedirectScheme) "true" else "false"
            variant.manifestPlaceholders.put("oidcRedirectScheme", scheme)
            variant.manifestPlaceholders.put("oidcActivityExported", exported)
            // A test component builds its own APK, merging the runtime's manifest into it, and
            // keeps a placeholder map of its own: values set on the variant do not reach it.
            variant.nestedComponents.filterIsInstance<TestComponent>().forEach { component ->
                component.manifestPlaceholders.put("oidcRedirectScheme", scheme)
                component.manifestPlaceholders.put("oidcActivityExported", exported)
            }
        }
    }
}

/**
 * One of a module's compilation targets, reduced to what the relay decision depends on.
 *
 * [konanTarget] is null for every target that is not Kotlin/Native.
 */
internal data class TargetPlatform(
    val platformType: KotlinPlatformType,
    val konanTarget: KonanTarget? = null,
)

/**
 * Maps a multiplatform module's targets to how strongly it needs a relay target.
 *
 * A module emits one shared source set, so the decision covers every target at once: if they
 * all register a URL scheme with the operating system then a missing value cannot work
 * anywhere, while a module that also builds for a platform receiving the relay on loopback
 * still has a working target without one.
 *
 * [KotlinPlatformType.common] is excluded because the metadata target is added automatically
 * and compiles no platform code.
 */
internal fun relayToRequirementFor(targets: Collection<TargetPlatform>): RelayToRequirement {
    val platforms = targets.filter { it.platformType != KotlinPlatformType.common }
    return when {
        platforms.isEmpty() -> RelayToRequirement.NotNeeded
        platforms.all { it.registersUrlScheme() } -> RelayToRequirement.Required
        platforms.any { it.registersUrlScheme() } -> RelayToRequirement.Recommended
        else -> RelayToRequirement.NotNeeded
    }
}

/**
 * Whether apps built for this target register their relay scheme with the operating system.
 *
 * Only the platforms known to need one qualify. A platform this does not recognise is treated
 * as not needing a relay target, so adding a target never turns a working build into one that
 * emits stubs.
 */
private fun TargetPlatform.registersUrlScheme(): Boolean = when (platformType) {
    KotlinPlatformType.androidJvm -> true
    KotlinPlatformType.native -> konanTarget?.family == Family.IOS
    else -> false
}
