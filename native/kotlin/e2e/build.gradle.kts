plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.kotlinx.serialization)
    id("com.aws.blocks.kotlin")
}

kotlin {
    jvm()

    iosSimulatorArm64()

    sourceSets {
        commonMain.dependencies {
            implementation("com.aws.blocks.kotlin:runtime")
        }

        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation(libs.kotest.assertions.core)
            implementation(libs.kotlinx.coroutines.test)
        }

        jvmTest.dependencies {
            implementation(libs.kotest.runner.junit5)
            implementation(libs.ktor.client.okhttp)
        }

        iosTest.dependencies {
            implementation(libs.ktor.client.darwin)
        }
    }
}

tasks.named<Test>("jvmTest") {
    useJUnitPlatform()
    val url = providers.systemProperty("BLOCKS_URL").orElse(
        providers.environmentVariable("BLOCKS_URL")
    ).getOrElse("")
    systemProperty("BLOCKS_URL", url)
    environment("BLOCKS_URL", url)
}

awsBlocks {
    apiSpec = file("blocks.spec.json")
    packageName = "blocks.e2e"
}
