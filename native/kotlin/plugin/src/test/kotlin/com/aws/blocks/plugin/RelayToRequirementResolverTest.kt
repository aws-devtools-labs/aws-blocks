package com.aws.blocks.plugin

import com.aws.blocks.kotlin.generator.RelayToRequirement
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import org.jetbrains.kotlin.gradle.plugin.KotlinPlatformType
import org.jetbrains.kotlin.konan.target.KonanTarget

private val android = TargetPlatform(KotlinPlatformType.androidJvm)
private val desktop = TargetPlatform(KotlinPlatformType.jvm)
private val browser = TargetPlatform(KotlinPlatformType.js)
private val metadata = TargetPlatform(KotlinPlatformType.common)
private val ios = TargetPlatform(KotlinPlatformType.native, KonanTarget.IOS_ARM64)
private val iosSimulator = TargetPlatform(KotlinPlatformType.native, KonanTarget.IOS_SIMULATOR_ARM64)
private val macos = TargetPlatform(KotlinPlatformType.native, KonanTarget.MACOS_ARM64)
private val linux = TargetPlatform(KotlinPlatformType.native, KonanTarget.LINUX_X64)

class RelayToRequirementResolverTest : FunSpec({

    test("every target registering a scheme is Required") {
        relayToRequirementFor(listOf(android, ios)) shouldBe RelayToRequirement.Required
    }

    test("an android-only target set is Required") {
        relayToRequirementFor(listOf(android)) shouldBe RelayToRequirement.Required
    }

    test("an ios-only target set is Required") {
        relayToRequirementFor(listOf(ios, iosSimulator)) shouldBe RelayToRequirement.Required
    }

    test("the metadata target does not stop a set from being Required") {
        // KMP always adds a metadata target, so counting it would make Required unreachable.
        relayToRequirementFor(listOf(metadata, android, ios)) shouldBe RelayToRequirement.Required
    }

    test("a mix of scheme-registering and other targets is Recommended") {
        relayToRequirementFor(listOf(android, desktop)) shouldBe RelayToRequirement.Recommended
    }

    test("ios alongside desktop is Recommended") {
        relayToRequirementFor(listOf(ios, desktop)) shouldBe RelayToRequirement.Recommended
    }

    test("no scheme-registering target is NotNeeded") {
        relayToRequirementFor(listOf(desktop, browser)) shouldBe RelayToRequirement.NotNeeded
    }

    test("a target set with nothing but metadata is NotNeeded") {
        relayToRequirementFor(listOf(metadata)) shouldBe RelayToRequirement.NotNeeded
    }

    test("an empty target set is NotNeeded") {
        relayToRequirementFor(emptyList()) shouldBe RelayToRequirement.NotNeeded
    }

    test("a non-apple native target does not count as registering a scheme") {
        relayToRequirementFor(listOf(linux)) shouldBe RelayToRequirement.NotNeeded
    }

    test("macOS does not count as registering a scheme") {
        relayToRequirementFor(listOf(macos)) shouldBe RelayToRequirement.NotNeeded
    }

    test("ios alongside another native target is Recommended rather than Required") {
        relayToRequirementFor(listOf(ios, macos)) shouldBe RelayToRequirement.Recommended
    }

    test("a native target of unknown platform is treated as not registering a scheme") {
        relayToRequirementFor(listOf(TargetPlatform(KotlinPlatformType.native))) shouldBe
            RelayToRequirement.NotNeeded
    }
})
