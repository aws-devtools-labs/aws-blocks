import org.jetbrains.kotlin.gradle.targets.native.tasks.KotlinNativeSimulatorTest

plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.kotlinx.serialization)
    id("com.aws.blocks.kotlin")
}

kotlin {
    jvm()

    iosSimulatorArm64 {
        // PersistentCookiesStorage on iOS is Keychain-backed. The bare Kotlin/Native
        // simulator test binary has no keychain-access-groups entitlement, so Keychain
        // calls fail with errSecNotAvailable and session cookies never persist. Embed an
        // entitlements section into the test binary; combined with the booted, non-standalone
        // test run configured below, the simulator honors the entitlement so the Keychain
        // works under test.
        binaries.getTest("DEBUG").linkerOpts(
            "-sectcreate", "__TEXT", "__entitlements",
            "${projectDir}/entitlements.plist"
        )
    }

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

// Boots and opens an iOS simulator. The Keychain-backed tests run non-standalone against a
// booted device (see below), which requires a simulator to already be running. Making the
// iOS test task depend on this keeps CI and local `run-e2e.sh` working without a manual boot.
val launchIosSimulator by tasks.registering(Exec::class) {
    isIgnoreExitValue = true
    // No-op if a simulator is already booted; otherwise boot the first available iPhone.
    // `open -a Simulator` is macOS-only and harmless if already open.
    commandLine(
        "sh", "-c",
        """
        if ! xcrun simctl list devices booted | grep -q Booted; then
            udid=${'$'}(xcrun simctl list devices available | grep -Eo '[0-9A-F-]{36}' | head -1)
            [ -n "${'$'}udid" ] && xcrun simctl boot "${'$'}udid"
        fi
        open -a Simulator 2>/dev/null || true
        """.trimIndent()
    )
}

tasks.withType<KotlinNativeSimulatorTest>().configureEach {
    dependsOn(launchIosSimulator)
    // Launch as an app on a booted simulator (not a standalone `simctl spawn`) so the
    // embedded keychain-access-groups entitlement is honored and Keychain storage works.
    standalone.set(false)
    device.set("booted")
}

awsBlocks {
    apiSpec = file("blocks.spec.json")
    packageName = "blocks.e2e"
}
