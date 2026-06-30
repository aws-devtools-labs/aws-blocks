package com.aws.blocks.kotlin.oidc

import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.test.runTest
import kotlin.test.Test

class PendingOidcResultTest {

    @Test
    fun `complete resolves the deferred with the URI`() = runTest {
        val deferred = PendingOidcResult.create()
        PendingOidcResult.complete("https://example.com/callback?code=abc")
        deferred.await() shouldBe "https://example.com/callback?code=abc"
    }

    @Test
    fun `cancel rejects the deferred with OidcCancelledException`() = runTest {
        val deferred = PendingOidcResult.create()
        PendingOidcResult.cancel()
        shouldThrow<OidcCancelledException> { deferred.await() }
    }

    @Test
    fun `create replaces previous deferred`() = runTest {
        val first = PendingOidcResult.create()
        val second = PendingOidcResult.create()

        PendingOidcResult.complete("result")

        second.await() shouldBe "result"
        // create() cancels the previous deferred; a cancelled deferred is completed,
        // so assert it was cancelled (not that it is incomplete).
        first.isCancelled shouldBe true
    }

    @Test
    fun `complete is safe when no deferred exists`() = runTest {
        PendingOidcResult.complete("orphan")
    }

    @Test
    fun `cancel is safe when no deferred exists`() = runTest {
        PendingOidcResult.cancel()
    }

    @Test
    fun `complete clears the deferred so subsequent calls are no-ops`() = runTest {
        val deferred = PendingOidcResult.create()
        PendingOidcResult.complete("first")
        deferred.await() shouldBe "first"

        val second = PendingOidcResult.create()
        PendingOidcResult.complete("second")
        second.await() shouldBe "second"
    }
}
