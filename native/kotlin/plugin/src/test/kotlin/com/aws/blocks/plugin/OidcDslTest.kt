package com.aws.blocks.plugin

import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.gradle.api.GradleException

@Suppress("DEPRECATION")
class OidcDslTest : FunSpec({

    test("resolve returns null when neither name is set") {
        OidcDsl().resolve() shouldBe null
    }

    test("resolve returns relayTo when only relayTo is set") {
        val dsl = OidcDsl().apply { relayTo = "myapp://auth" }
        dsl.resolve() shouldBe "myapp://auth"
    }

    test("resolve returns redirectUrl when only the deprecated name is set") {
        val dsl = OidcDsl().apply { redirectUrl = "myapp://auth" }
        dsl.resolve() shouldBe "myapp://auth"
    }

    test("resolve accepts both names when they agree") {
        val dsl = OidcDsl().apply {
            relayTo = "myapp://auth"
            redirectUrl = "myapp://auth"
        }
        dsl.resolve() shouldBe "myapp://auth"
    }

    test("resolve fails when both names are set to different values") {
        val dsl = OidcDsl().apply {
            relayTo = "myapp://auth"
            redirectUrl = "other://auth"
        }
        val error = shouldThrow<GradleException> { dsl.resolve() }
        error.message!! shouldContain "relayTo"
        error.message!! shouldContain "redirectUrl"
    }
})
