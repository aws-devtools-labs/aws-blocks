package com.aws.blocks.kotlin

import io.kotest.matchers.shouldBe
import kotlin.test.Test

/**
 * Stands in for the accessor code generation emits next to the `Servers` constants, so that
 * removing the companion from [Blocks] fails here rather than in a customer's build.
 */
private operator fun Blocks.Companion.invoke(): Blocks =
    Blocks(BlocksServer(name = "generated", url = "http://localhost:3001/aws-blocks/api"))

class BlocksCompanionInvokeTest {

    @Test
    fun `a companion accessor can supply the server so callers need no argument`() {
        Blocks().use { blocks ->
            blocks.server.name shouldBe "generated"
        }
    }
}
