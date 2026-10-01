package com.aws.blocks.kotlin.oidc

import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.string.shouldStartWith
import kotlin.test.Test

class OidcLoopbackPagesTest {

    @Test
    fun `success page is a complete document`() {
        val page = OidcLoopbackPages.success()
        page shouldStartWith "<!DOCTYPE html>"
        page shouldContain "<html lang=\"en\">"
        page shouldContain "<meta charset=\"utf-8\">"
        page shouldContain "<title>"
        page shouldContain "prefers-color-scheme"
    }

    @Test
    fun `every page declares an inline icon so no favicon request is provoked`() {
        for (page in listOf(
            OidcLoopbackPages.success(),
            OidcLoopbackPages.failure(null, null),
        )) {
            page shouldContain "<link rel=\"icon\" href=\"data:image/svg+xml,"
        }
    }

    @Test
    fun `no page fetches anything over the network`() {
        for (page in listOf(
            OidcLoopbackPages.success(),
            OidcLoopbackPages.failure("access_denied", "nope"),
        )) {
            page shouldNotContain "http://"
            page shouldNotContain "https://www."
        }
    }

    @Test
    fun `failure page shows the error code and description in their own element`() {
        val page = OidcLoopbackPages.failure("access_denied", "The user said no")
        page shouldContain "<p class=\"detail\">access_denied — The user said no</p>"
    }

    @Test
    fun `failure page omits the detail element entirely when there is no detail`() {
        OidcLoopbackPages.failure(null, null) shouldNotContain "class=\"detail\""
    }

    @Test
    fun `failure page escapes the error description`() {
        val page = OidcLoopbackPages.failure("bad", "<script>alert(1)</script>")
        page shouldNotContain "<script>"
        page shouldContain "&lt;script&gt;"
    }

    @Test
    fun `failure page still tells the user what to do when the provider sent no detail`() {
        val page = OidcLoopbackPages.failure(null, null)
        page shouldContain "Sign-in failed"
        page shouldContain "try again in the app"
    }
}
