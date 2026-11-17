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

    test("resolve rejects a value with no scheme separator") {
        val dsl = OidcDsl().apply { relayTo = "myapp" }
        val error = shouldThrow<GradleException> { dsl.resolve() }
        error.message!! shouldContain "scheme"
    }

    test("resolve rejects an https value") {
        val dsl = OidcDsl().apply { relayTo = "https://example.com/callback" }
        val error = shouldThrow<GradleException> { dsl.resolve() }
        error.message!! shouldContain "custom scheme"
    }

    test("resolve rejects a value containing whitespace") {
        val dsl = OidcDsl().apply { relayTo = "my app://auth" }
        val error = shouldThrow<GradleException> { dsl.resolve() }
        error.message!! shouldContain "whitespace"
    }

    test("resolve accepts a dotted custom scheme") {
        val dsl = OidcDsl().apply { relayTo = "com.example.app://auth/callback" }
        dsl.resolve() shouldBe "com.example.app://auth/callback"
    }
})
