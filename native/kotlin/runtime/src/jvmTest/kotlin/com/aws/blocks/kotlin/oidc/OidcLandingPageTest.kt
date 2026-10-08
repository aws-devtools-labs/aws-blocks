package com.aws.blocks.kotlin.oidc

import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlin.test.Test

class OidcLandingPageTest {

    @Test
    fun `redirect accepts an https url`() {
        OidcLandingPage.Redirect("https://app.example.com/signed-in").url shouldBe
            "https://app.example.com/signed-in"
    }

    @Test
    fun `redirect accepts http on a loopback host`() {
        OidcLandingPage.Redirect("http://localhost:3000/signed-in")
        OidcLandingPage.Redirect("http://127.0.0.1:3000/signed-in")
        OidcLandingPage.Redirect("http://[::1]:3000/signed-in")
    }

    @Test
    fun `redirect rejects http on a remote host`() {
        val error = shouldThrow<IllegalArgumentException> {
            OidcLandingPage.Redirect("http://app.example.com/signed-in")
        }
        error.message!! shouldContain "non-loopback"
    }

    @Test
    fun `redirect rejects a missing scheme`() {
        val error = shouldThrow<IllegalArgumentException> {
            OidcLandingPage.Redirect("app.example.com/signed-in")
        }
        error.message!! shouldContain "missing a scheme"
    }

    @Test
    fun `redirect rejects a non-http scheme`() {
        val error = shouldThrow<IllegalArgumentException> {
            OidcLandingPage.Redirect("javascript://alert(1)")
        }
        error.message!! shouldContain "javascript"
    }

    @Test
    fun `redirect rejects a url with no host`() {
        val error = shouldThrow<IllegalArgumentException> {
            OidcLandingPage.Redirect("https:///signed-in")
        }
        error.message!! shouldContain "no host"
    }

    @Test
    fun `redirect rejects whitespace`() {
        val error = shouldThrow<IllegalArgumentException> {
            OidcLandingPage.Redirect("https://app.example.com/signed in")
        }
        error.message!! shouldContain "whitespace"
    }

    @Test
    fun `redirect rejects a blank url`() {
        shouldThrow<IllegalArgumentException> { OidcLandingPage.Redirect("  ") }
    }

    @Test
    fun `redirect rejects a malformed url with the parser's reason`() {
        val error = shouldThrow<IllegalArgumentException> {
            OidcLandingPage.Redirect("https://[::1/signed-in")
        }
        error.message!! shouldContain "not a valid URL"
    }

    @Test
    fun `redirect ignores userinfo when finding the host`() {
        val error = shouldThrow<IllegalArgumentException> {
            OidcLandingPage.Redirect("http://localhost@app.example.com/signed-in")
        }
        error.message!! shouldContain "non-loopback"
    }

    @Test
    fun `redirect accepts every spelling of a loopback host over http`() {
        OidcLandingPage.Redirect("http://127.0.0.2:3000/done")
        OidcLandingPage.Redirect("http://[0:0:0:0:0:0:0:1]:3000/done")
    }

    @Test
    fun `redirect rejects an out-of-range port`() {
        val error = shouldThrow<IllegalArgumentException> {
            OidcLandingPage.Redirect("https://app.example.com:99999/done")
        }
        error.message!! shouldContain "out-of-range port"
    }

    @Test
    fun `redirect explains an unusable host rather than claiming there is none`() {
        val error = shouldThrow<IllegalArgumentException> {
            OidcLandingPage.Redirect("https://b\u00fccher.de/done")
        }
        error.message!! shouldContain "punycode"
    }

    @Test
    fun `redirect accepts a punycoded internationalised domain`() {
        OidcLandingPage.Redirect("https://xn--bcher-kva.de/done")
    }

    @Test
    fun `html rejects a blank document`() {
        val error = shouldThrow<IllegalArgumentException> { OidcLandingPage.Html("  ") }
        error.message!! shouldContain "document"
    }

    @Test
    fun `options default to the built-in pages on both arms`() {
        val options = OidcSignInOptions()
        options.platformOptions.successPage shouldBe OidcLandingPage.BuiltIn
        options.platformOptions.errorPage shouldBe OidcLandingPage.BuiltIn
    }
}
