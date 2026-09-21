package com.aws.blocks.plugin

import com.aws.blocks.kotlin.generator.RelayToRequirement
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import org.jetbrains.kotlin.gradle.plugin.KotlinPlatformType

class RelayToRequirementResolverTest : FunSpec({

    test("every target registering a scheme is Required") {
        relayToRequirementFor(listOf(KotlinPlatformType.androidJvm, KotlinPlatformType.native)) shouldBe
            RelayToRequirement.Required
    }

    test("an android-only target set is Required") {
        relayToRequirementFor(listOf(KotlinPlatformType.androidJvm)) shouldBe RelayToRequirement.Required
    }

    test("an ios-only target set is Required") {
        relayToRequirementFor(listOf(KotlinPlatformType.native)) shouldBe RelayToRequirement.Required
    }

    test("the metadata target does not stop a set from being Required") {
        // KMP always adds a metadata target, so counting it would make Required unreachable.
        relayToRequirementFor(
            listOf(KotlinPlatformType.common, KotlinPlatformType.androidJvm, KotlinPlatformType.native),
        ) shouldBe RelayToRequirement.Required
    }

    test("a mix of scheme-registering and other targets is Recommended") {
        relayToRequirementFor(listOf(KotlinPlatformType.androidJvm, KotlinPlatformType.jvm)) shouldBe
            RelayToRequirement.Recommended
    }

    test("ios alongside desktop is Recommended") {
        relayToRequirementFor(listOf(KotlinPlatformType.native, KotlinPlatformType.jvm)) shouldBe
            RelayToRequirement.Recommended
    }

    test("no scheme-registering target is NotNeeded") {
        relayToRequirementFor(listOf(KotlinPlatformType.jvm, KotlinPlatformType.js)) shouldBe
            RelayToRequirement.NotNeeded
    }

    test("a target set with nothing but metadata is NotNeeded") {
        relayToRequirementFor(listOf(KotlinPlatformType.common)) shouldBe RelayToRequirement.NotNeeded
    }

    test("an empty target set is NotNeeded") {
        relayToRequirementFor(emptyList()) shouldBe RelayToRequirement.NotNeeded
    }
})
