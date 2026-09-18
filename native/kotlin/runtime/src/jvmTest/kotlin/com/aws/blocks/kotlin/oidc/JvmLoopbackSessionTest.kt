@file:OptIn(InternalBlocksApi::class)

package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.InternalBlocksApi
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldStartWith
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URI
import kotlin.test.Test
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext

class JvmLoopbackSessionTest {

    private fun get(url: String): Int = withRealConnection(url) { it.responseCode }

    private fun <T> withRealConnection(url: String, block: (HttpURLConnection) -> T): T {
        val connection = URI(url).toURL().openConnection() as HttpURLConnection
        return try {
            block(connection)
        } finally {
            connection.disconnect()
        }
    }

    @Test
    fun `relayTo is a live loopback address`() = runBlocking<Unit> {
        val session = JvmLoopbackSession(BrowserOpener { }, 1.minutes)
        try {
            session.relayTo shouldStartWith "http://127.0.0.1:"
            session.relayTo shouldContain "/oidc/callback"
            // A bare GET with no auth parameters is not the callback.
            withContext(Dispatchers.IO) { get(session.relayTo) } shouldBe 404
        } finally {
            session.close()
        }
    }

    @Test
    fun `awaitRedirect returns the full callback url`() = runBlocking<Unit> {
        val session = JvmLoopbackSession(BrowserOpener { }, 1.minutes)
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            withContext(Dispatchers.IO) { get("${session.relayTo}?code=abc123&state=xyz") } shouldBe 200
            redirect.await() shouldBe "${session.relayTo}?code=abc123&state=xyz"
        } finally {
            session.close()
        }
    }

    @Test
    fun `awaitRedirect accepts an error callback`() = runBlocking<Unit> {
        val session = JvmLoopbackSession(BrowserOpener { }, 1.minutes)
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            withContext(Dispatchers.IO) { get("${session.relayTo}?error=access_denied") }
            redirect.await() shouldContain "error=access_denied"
        } finally {
            session.close()
        }
    }

    @Test
    fun `awaitRedirect opens the authorize url in the browser`() = runBlocking<Unit> {
        var opened: String? = null
        val session = JvmLoopbackSession(BrowserOpener { opened = it }, 1.minutes)
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize?x=1") }
            withContext(Dispatchers.IO) { get("${session.relayTo}?code=abc") }
            redirect.await()
            opened shouldBe "https://idp.example.com/authorize?x=1"
        } finally {
            session.close()
        }
    }

    @Test
    fun `awaitRedirect times out as a cancellation`() = runBlocking<Unit> {
        val session = JvmLoopbackSession(BrowserOpener { }, 50.milliseconds)
        try {
            val error = shouldThrow<OidcCancelledException> {
                session.awaitRedirect("https://idp.example.com/authorize")
            }
            error.message!! shouldContain "timed out"
            error.message!! shouldContain session.relayTo
        } finally {
            session.close()
        }
    }

    @Test
    fun `close releases the port`() = runBlocking<Unit> {
        val session = JvmLoopbackSession(BrowserOpener { }, 1.minutes)
        val port = URI(session.relayTo).port
        session.close()

        // Re-binding the same port proves the listener is gone.
        ServerSocket().use { socket ->
            socket.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port))
            socket.localPort shouldBe port
        }
    }

    @Test
    fun `openSession ignores the configured relay target`() = runBlocking<Unit> {
        val launcher = JvmOidcLauncher(BrowserOpener { }, 1.minutes)
        val session = launcher.openSession("myapp://auth/callback")
        try {
            session.relayTo shouldStartWith "http://127.0.0.1:"
        } finally {
            session.close()
        }
    }
}
