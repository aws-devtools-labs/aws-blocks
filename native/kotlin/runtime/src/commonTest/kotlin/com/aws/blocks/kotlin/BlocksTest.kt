package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.exceptions.BlocksException
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlinx.coroutines.isActive
import kotlinx.coroutines.test.runTest
import kotlin.test.Test

class BlocksTest {

    private val server = BlocksServer(name = "test", url = "http://localhost:3001/aws-blocks/api")

    @Test
    fun `the owned client targets the server it was constructed with`() {
        Blocks(server).use { blocks ->
            blocks.client().server shouldBe server
        }
    }

    @Test
    fun `repeated access returns the one client the instance owns`() {
        Blocks(server).use { blocks ->
            (blocks.client() === blocks.client()) shouldBe true
        }
    }

    @Test
    fun `close shuts down the http client it owns`() {
        val blocks = Blocks(server)
        val httpClient = blocks.client().httpClient

        blocks.close()

        httpClient.isActive shouldBe false
    }

    @Test
    fun `a request after close names the instance rather than failing inside the engine`() = runTest {
        val blocks = Blocks(server)
        blocks.close()

        val failure = shouldThrow<BlocksException> {
            blocks.client().execute(BlocksRequest(method = "api.list", params = emptyList(), id = 1))
        }

        failure.message!! shouldContain "closed"
    }

    @Test
    fun `closing twice is not an error`() {
        val blocks = Blocks(server)

        blocks.close()
        blocks.close()
    }

    @Test
    fun `it is an AutoCloseable so callers can scope it to a block`() {
        val closeable: AutoCloseable = Blocks(server)

        closeable.close()
    }
}
