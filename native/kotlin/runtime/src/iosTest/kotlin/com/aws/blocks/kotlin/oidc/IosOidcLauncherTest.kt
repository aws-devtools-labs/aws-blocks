@file:OptIn(InternalBlocksApi::class)

package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.InternalBlocksApi
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlin.test.Test
import kotlinx.coroutines.test.runTest

class IosOidcLauncherTest {

    @Test
    fun `openSession rejects an unconfigured relay target`() = runTest {
        val error = shouldThrow<IllegalStateException> {
            IosOidcLauncher().openSession("")
        }
        error.message!! shouldContain "relayTo"
    }

    @Test
    fun `openSession rejects a value with no scheme`() = runTest {
        val error = shouldThrow<IllegalStateException> {
            IosOidcLauncher().openSession("not-a-uri")
        }
        error.message!! shouldContain "custom-scheme"
    }

    @Test
    fun `openSession rejects an https relay target`() = runTest {
        val error = shouldThrow<IllegalStateException> {
            IosOidcLauncher().openSession("https://example.com/callback")
        }
        error.message!! shouldContain "CFBundleURLTypes"
    }

    @Test
    fun `openSession accepts a custom scheme and echoes it back`() = runTest {
        val session = IosOidcLauncher().openSession("myapp://auth/callback")
        try {
            session.relayTo shouldBe "myapp://auth/callback"
        } finally {
            session.close()
        }
    }
}
