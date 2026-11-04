package com.aws.blocks.kotlin

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * A [Blocks] instance's cookie jar comes from its own configuration, so two instances configured
 * with different storage locations hold different sessions — which is what one process-wide jar
 * under `$HOME` could not do.
 */
class JvmBlocksStorageTest {

    private val appA: File = Files.createTempDirectory("blocks-instance-a").toFile()
    private val appB: File = Files.createTempDirectory("blocks-instance-b").toFile()

    @AfterTest
    fun cleanUp() {
        appA.deleteRecursively()
        appB.deleteRecursively()
        relaunch()
    }

    /**
     * Stands in for a relaunched process. Clients persisting to one location share a jar for the
     * life of the process, so without this a "later instance" would read the jar the earlier one
     * still holds in memory and prove nothing about what reached storage.
     */
    private fun relaunch() = forgetCookieJars()

    private val server = BlocksServer(name = "test", url = "https://example.com/aws-blocks/api")

    /** Answers every call with a session cookie, and records the cookies it was sent. */
    private class Backend(private val setCookie: String = "session=a-session; Path=/") {
        val received = mutableListOf<HttpRequestData>()

        fun engine() = MockEngine { request ->
            received += request
            respond(
                content = ByteReadChannel("""{"jsonrpc":"2.0","result":"ok","id":1}"""),
                status = HttpStatusCode.OK,
                headers = headersOf(
                    HttpHeaders.ContentType to listOf("application/json"),
                    HttpHeaders.SetCookie to listOf(setCookie),
                ),
            )
        }
    }

    private suspend fun call(blocks: Blocks) {
        blocks.client().execute(BlocksRequest(method = "api.greet", params = emptyList(), id = 1))
    }

    private fun blocksIn(
        location: File,
        backend: Backend,
        server: BlocksServer = this.server,
    ): Blocks = Blocks(
        BlocksConfig(
            server = server,
            platformConfig = BlocksPlatformConfig(storageLocation = location),
        ),
        backend.engine(),
    )

    @Test
    fun `two instances at one location do not discard each other's cookies`() = runTest {
        // An environment switcher: two instances, two backends, one application directory. Each
        // holds its jar in memory and mirrors the whole thing on write, so unless they share that
        // jar the second write replaces the first instance's cookies rather than adding to them.
        val hostA = BlocksServer(name = "a", url = "https://a.example.com/aws-blocks/api")
        val hostB = BlocksServer(name = "b", url = "https://b.example.com/aws-blocks/api")

        val a = blocksIn(appA, Backend("session=from-a; Path=/"), hostA)
        val b = blocksIn(appA, Backend("session=from-b; Path=/"), hostB)
        call(a)
        call(b)
        // A writes again from the state it has held since its own first call, which is where a jar
        // it does not share with B loses B's cookie.
        call(a)
        a.close()
        b.close()
        // Read it back from storage rather than from the jar they shared, so this covers the
        // merged jar reaching disk as well as the two instances agreeing on it.
        relaunch()

        val next = Backend("session=from-b; Path=/")
        blocksIn(appA, next, hostB).use { call(it) }

        next.received.single().headers[HttpHeaders.Cookie] shouldBe "session=from-b"
    }

    @Test
    fun `an instance persists its session to the location its configuration names`() = runTest {
        blocksIn(appA, Backend()).use { call(it) }

        File(appA, "cookies").isDirectory shouldBe true
        File(appB, "cookies").exists() shouldBe false
    }

    @Test
    fun `a later instance at the same location resumes the session`() = runTest {
        blocksIn(appA, Backend()).use { call(it) }
        relaunch()

        val next = Backend()
        blocksIn(appA, next).use { call(it) }

        next.received.single().headers[HttpHeaders.Cookie] shouldBe "session=a-session"
    }

    @Test
    fun `an instance at a different location does not see the session`() = runTest {
        blocksIn(appA, Backend()).use { call(it) }
        relaunch()

        val other = Backend()
        blocksIn(appB, other).use { call(it) }

        other.received.single().headers.getAll(HttpHeaders.Cookie).orEmpty().shouldBeEmpty()
    }

    @Test
    fun `an instance with no location configured persists nothing`() = runTest {
        Blocks(BlocksConfig(server = server), Backend().engine()).use { call(it) }

        val next = Backend()
        Blocks(BlocksConfig(server = server), next.engine()).use { call(it) }

        next.received.single().headers.getAll(HttpHeaders.Cookie).orEmpty().shouldBeEmpty()
    }

    @Test
    fun `clearStoredState drops the session the instance stored`() = runTest {
        blocksIn(appA, Backend()).use { blocks ->
            call(blocks)
            blocks.clearStoredState()
        }
        relaunch()

        val next = Backend()
        blocksIn(appA, next).use { call(it) }

        next.received.single().headers.getAll(HttpHeaders.Cookie).orEmpty().shouldBeEmpty()
    }
}
