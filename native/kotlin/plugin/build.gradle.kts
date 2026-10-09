/*
 * Copyright 2024 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at
 *
 *  http://aws.amazon.com/apache2.0
 *
 * or in the "license" file accompanying this file. This file is distributed
 * on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlinx.serialization)
    `java-gradle-plugin`
    alias(libs.plugins.maven.publish)
}

dependencies {
    implementation(projects.codegen)

    // Android Gradle Plugin API — compileOnly so the consumer's own AGP version is used at runtime
    compileOnly(libs.plugins.android.application.get().let {
        "${it.pluginId}:${it.pluginId}.gradle.plugin:${it.version}"
    })

    // Kotlin Gradle Plugin API — compileOnly so the consumer's own KGP version is used at runtime
    compileOnly(libs.plugins.kotlin.multiplatform.get().let {
        "${it.pluginId}:${it.pluginId}.gradle.plugin:${it.version}"
    })

    testImplementation(libs.kotest.runner.junit5)
    testImplementation(libs.kotest.assertions.core)
    testImplementation(libs.kotest.property)

    // Tests assert over KotlinPlatformType, which main only needs at compile time.
    testImplementation(libs.plugins.kotlin.multiplatform.get().let {
        "${it.pluginId}:${it.pluginId}.gradle.plugin:${it.version}"
    })
}

tasks.withType<Test> {
    useJUnitPlatform()
}

gradlePlugin {
    plugins {
        register("aws-blocks") {
            id = "com.aws.blocks.kotlin"
            implementationClass = "com.aws.blocks.plugin.AwsBlocksCodegenPlugin"
        }
    }
}
