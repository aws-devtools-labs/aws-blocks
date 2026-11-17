// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Top-level build file where you can add configuration options common to all sub-projects/modules.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.multiplatform) apply false
    alias(libs.plugins.android.kotlin.multiplatform) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlinx.serialization) apply false
}

subprojects {
    group = "com.aws.blocks.kotlin"

    // Android AAR and iOS klib artifacts do not yet get META-INF LICENSE/NOTICE;
    // adding them needs verification with the Android SDK.
    // Ship LICENSE and NOTICE under META-INF/ in every jar a module builds: the
    // KMP `jvmJar`, the `:codegen` and `:plugin` jars, and the sources/javadoc
    // jars maven-publish attaches. `configureEach` also reaches jar tasks a
    // plugin registers after this block runs. `org.gradle.jvm.tasks.Jar` (not the
    // `bundling.Jar` subclass) is the type KMP uses for its sources jars.
    tasks.withType<org.gradle.jvm.tasks.Jar>().configureEach {
        from(files(rootProject.file("LICENSE"), rootProject.file("NOTICE"))) {
            into("META-INF")
        }
    }
}
