package com.aws.blocks.kotlin.oidc

import io.kotest.matchers.shouldBe
import kotlin.test.Test

class OidcExceptionTest {

    @Test
    fun `cancelled defaults to a generic message`() {
        OidcCancelledException().message shouldBe "Sign-in cancelled"
    }

    @Test
    fun `cancelled accepts a specific message`() {
        val exception = OidcCancelledException("Sign-in timed out after 5m")
        exception.message shouldBe "Sign-in timed out after 5m"
    }
}
