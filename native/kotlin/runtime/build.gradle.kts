plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.kotlin.multiplatform)
    alias(libs.plugins.kotlinx.serialization)
    alias(libs.plugins.maven.publish)
}

kotlin {
    jvm()

    android {
        namespace = "com.aws.blocks.kotlin"
        compileSdk = 36
        minSdk = 23
        withHostTest {}
    }

    iosX64()
    iosArm64()
    iosSimulatorArm64()

    sourceSets {
        commonMain.dependencies {
            implementation(libs.ktor.client.core)
            implementation(libs.ktor.client.websockets)
            implementation(libs.ktor.client.content.negotiation)
            implementation(libs.ktor.client.logging)
            implementation(libs.ktor.serialization.kotlinx.json)
            implementation(libs.kotlinx.atomicfu)
            api(libs.kotlinx.serialization.json)
            api(libs.kotlinx.datetime)
        }

        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation(libs.kotest.assertions.core)
            implementation(libs.kotest.property)
            implementation(libs.kotlinx.coroutines.test)
            implementation(libs.ktor.client.mock)
        }

        androidMain.dependencies {
            implementation(libs.ktor.client.okhttp)
            implementation(libs.androidx.security.crypto)
            implementation(libs.androidx.startup.runtime)
            implementation(libs.androidx.browser)
            implementation(libs.androidx.activity.ktx)
        }

        jvmMain.dependencies {
            implementation(libs.ktor.client.okhttp)
        }

        iosMain.dependencies {
            implementation(libs.ktor.client.darwin)
        }
    }
}

// Kotlin ships a compiled artifact, so the version is generated at build time
// from VERSION_NAME (unlike Swift/Dart, which commit the constant).
val versionOutputDir = layout.buildDirectory.dir("generated/version/commonMain/kotlin")

val generateVersion by tasks.registering {
    val outputDir = versionOutputDir
    val versionValue = (project.findProperty("VERSION_NAME") as String?)
        ?: error("VERSION_NAME is not set in gradle.properties")
    inputs.property("version", versionValue)
    outputs.dir(outputDir)
    doLast {
        // Reject versions outside the N.N.N[-prerelease] token format.
        require(Regex("""^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$""").matches(versionValue)) {
            "VERSION_NAME \"$versionValue\" is outside the N.N.N[-prerelease] token format (no build metadata)."
        }
        val pkgDir = outputDir.get().dir("com/aws/blocks/kotlin").asFile
        pkgDir.mkdirs()
        pkgDir.resolve("Version.kt").writeText(
            """
            |package com.aws.blocks.kotlin
            |
            |internal const val blocksRuntimeVersion = "$versionValue"
            |
            |/** User agent token for this runtime, e.g. `aws-blocks-kotlin/$versionValue`. */
            |internal const val blocksUserAgentToken = "aws-blocks-kotlin/${'$'}blocksRuntimeVersion"
            |""".trimMargin(),
        )
    }
}

kotlin.sourceSets.named("commonMain") {
    kotlin.srcDir(generateVersion.map { versionOutputDir })
}
