plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.kotlin.multiplatform)
    alias(libs.plugins.kotlinx.serialization)
    alias(libs.plugins.maven.publish)
}

kotlin {
    compilerOptions {
        // This module declares InternalBlocksApi. The guarantee it withholds is one this
        // module makes to its consumers, so it does not constrain the module's own sources.
        optIn.add("com.aws.blocks.kotlin.InternalBlocksApi")
    }

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
