package com.aws.blocks.kotlin

import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldMatch
import kotlin.test.Test

class VersionTest {

    // Token format: aws-blocks-<lang>/<version>. The language is 1-16 lowercase alphanumeric
    // characters starting with a letter; version is numeric X.Y.Z with an optional prerelease and no build metadata.
    private val grammar = Regex("""^aws-blocks-([a-z][a-z0-9]{0,15})/(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$""")

    @Test
    fun `user agent token matches the expected format`() {
        blocksUserAgentToken shouldMatch grammar
    }

    @Test
    fun `user agent token keeps the aws-blocks prefix`() {
        blocksUserAgentToken shouldContain "aws-blocks"
    }

    @Test
    fun `user agent token embeds the runtime version`() {
        blocksUserAgentToken shouldBe "aws-blocks-kotlin/$blocksRuntimeVersion"
    }

    @Test
    fun `runtime version is valid semver`() {
        blocksRuntimeVersion shouldMatch Regex("""^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$""")
    }

    @Test
    fun `runtime version is not a placeholder`() {
        blocksRuntimeVersion shouldNotBe "0.0.0"
    }
}
