package com.aws.blocks.kotlin.oidc

import io.kotest.matchers.shouldBe
import kotlin.test.Test

class BrowserOpenerTest {

    @Test
    fun `macOS uses open`() {
        browserCommand("Mac OS X", "https://example.com/a") shouldBe
            listOf("open", "https://example.com/a")
    }

    @Test
    fun `windows uses the protocol handler`() {
        browserCommand("Windows 11", "https://example.com/a") shouldBe
            listOf("rundll32", "url.dll,FileProtocolHandler", "https://example.com/a")
    }

    @Test
    fun `other platforms use xdg-open`() {
        browserCommand("Linux", "https://example.com/a") shouldBe
            listOf("xdg-open", "https://example.com/a")
    }

    @Test
    fun `os name matching is case insensitive`() {
        browserCommand("MAC OS X", "https://example.com/a").first() shouldBe "open"
    }
}
